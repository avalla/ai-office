#![cfg(target_os = "linux")]

use crate::linux::{
    duplicate_cloexec, fsync_fd, openat2_beneath, renameat2, unlinkat, RENAME_NOREPLACE,
};
use crate::{validate_public_path, PathLimits, SpikeError, ValidatedPath};
use sha2::{Digest, Sha256};
use std::ffi::CString;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::fs::MetadataExt;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CommitCertainty {
    DefiniteNoMutation,
    MutationMayHaveOccurred,
    DefiniteSuccess,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FaultPoint {
    None,
    BeforeRename,
    AfterRename,
    BeforeParentFsync,
    AfterParentFsync,
    BeforeTombstoneUnlink,
    AfterTombstoneUnlink,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MutationAttestation {
    pub certainty: CommitCertainty,
    pub content_sha256: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MutationFailure {
    pub certainty: CommitCertainty,
    pub code: &'static str,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FileIdentity {
    pub device: u64,
    pub inode: u64,
    pub size: u64,
    pub sha256: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InternalOwnership {
    pub name: String,
    pub execution_id: String,
    pub random_identity: String,
    pub device: u64,
    pub inode: u64,
}

fn failure(certainty: CommitCertainty, code: &'static str) -> MutationFailure {
    MutationFailure { certainty, code }
}

fn before_commit(error: SpikeError) -> MutationFailure {
    let code = match error {
        SpikeError::DestinationExists => "destination_exists",
        SpikeError::SourcePrecondition => "source_precondition",
        SpikeError::UnsafeFileType => "unsafe_file_type",
        SpikeError::OwnershipUncertain => "ownership_uncertain",
        _ => "native_error",
    };
    failure(CommitCertainty::DefiniteNoMutation, code)
}

fn cstring(value: &str) -> Result<CString, SpikeError> {
    CString::new(value).map_err(|_| SpikeError::InvalidPath("path contains NUL"))
}

pub fn open_verified_parent(root_fd: RawFd, path: &ValidatedPath) -> Result<OwnedFd, SpikeError> {
    if path.parent().is_empty() {
        duplicate_cloexec(root_fd)
    } else {
        openat2_beneath(
            root_fd,
            path.parent(),
            libc::O_RDONLY | libc::O_DIRECTORY,
            0,
        )
    }
}

fn open_regular(parent_fd: RawFd, basename: &str) -> Result<File, SpikeError> {
    let basename = cstring(basename)?;
    // SAFETY: basename is a single validated CString and parent_fd is held by the caller.
    let fd = unsafe {
        libc::openat(
            parent_fd,
            basename.as_ptr(),
            libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK,
        )
    };
    if fd < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    // SAFETY: openat returned a new owned descriptor.
    let file = unsafe { File::from_raw_fd(fd) };
    let metadata = file.metadata()?;
    if !metadata.file_type().is_file() || metadata.nlink() > 1 {
        return Err(SpikeError::UnsafeFileType);
    }
    Ok(file)
}

fn inspect_open_file(file: &mut File) -> Result<FileIdentity, SpikeError> {
    let metadata = file.metadata()?;
    if !metadata.file_type().is_file() || metadata.nlink() > 1 {
        return Err(SpikeError::UnsafeFileType);
    }
    file.seek(SeekFrom::Start(0))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    Ok(FileIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
        size: metadata.size(),
        sha256: hex_sha256(&bytes),
    })
}

pub fn inspect_path(root_fd: RawFd, path: &str) -> Result<FileIdentity, SpikeError> {
    let path = validate_public_path(path, PathLimits::default())?;
    let parent = open_verified_parent(root_fd, &path)?;
    let mut file = open_regular(parent.as_raw_fd(), path.basename())?;
    inspect_open_file(&mut file)
}

fn path_is_absent(parent_fd: RawFd, basename: &str) -> Result<bool, SpikeError> {
    let basename = cstring(basename)?;
    // SAFETY: stat storage is initialized and basename/parent remain live.
    let mut stat: libc::stat = unsafe { std::mem::zeroed() };
    // SAFETY: fstatat writes to stat without following the final link.
    let result = unsafe {
        libc::fstatat(
            parent_fd,
            basename.as_ptr(),
            &mut stat,
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if result == 0 {
        Ok(false)
    } else {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ENOENT) {
            Ok(true)
        } else {
            Err(error.into())
        }
    }
}

fn random_identity() -> Result<String, SpikeError> {
    let mut random = [0_u8; 16];
    File::open("/dev/urandom")?.read_exact(&mut random)?;
    Ok(random.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn internal_name(execution_id: &str, random: &str) -> Result<String, SpikeError> {
    if execution_id.is_empty()
        || random.is_empty()
        || !execution_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        || !random.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(SpikeError::OwnershipUncertain);
    }
    Ok(format!(".ai-office-txn-{execution_id}-{random}"))
}

fn create_stage(
    parent_fd: RawFd,
    execution_id: &str,
    content: &[u8],
    forced_random: Option<&str>,
) -> Result<(File, InternalOwnership, String), SpikeError> {
    let random = match forced_random {
        Some(value) => value.to_owned(),
        None => random_identity()?,
    };
    let name = internal_name(execution_id, &random)?;
    let c_name = cstring(&name)?;
    // SAFETY: parent is held, name is valid, and mode accompanies O_CREAT.
    let fd = unsafe {
        libc::openat(
            parent_fd,
            c_name.as_ptr(),
            libc::O_RDWR | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
    };
    if fd < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    // SAFETY: openat returned a new owned descriptor.
    let mut file = unsafe { File::from_raw_fd(fd) };
    file.write_all(content)?;
    file.sync_all()?;
    let identity = inspect_open_file(&mut file)?;
    if identity.sha256 != hex_sha256(content) || identity.size != content.len() as u64 {
        return Err(SpikeError::SourcePrecondition);
    }
    Ok((
        file,
        InternalOwnership {
            name,
            execution_id: execution_id.to_owned(),
            random_identity: random,
            device: identity.device,
            inode: identity.inode,
        },
        identity.sha256,
    ))
}

pub fn cleanup_owned(parent_fd: RawFd, ownership: &InternalOwnership) -> Result<(), SpikeError> {
    let expected_name = internal_name(&ownership.execution_id, &ownership.random_identity)?;
    if expected_name != ownership.name {
        return Err(SpikeError::OwnershipUncertain);
    }
    let mut file = open_regular(parent_fd, &ownership.name)?;
    let identity = inspect_open_file(&mut file)?;
    if identity.device != ownership.device || identity.inode != ownership.inode {
        return Err(SpikeError::OwnershipUncertain);
    }
    unlinkat(parent_fd, &ownership.name)
}

fn injected(
    fault: FaultPoint,
    expected: FaultPoint,
    certainty: CommitCertainty,
) -> Result<(), MutationFailure> {
    if fault == expected {
        Err(failure(certainty, "fault_injected"))
    } else {
        Ok(())
    }
}

pub fn create_file(
    root_fd: RawFd,
    path: &str,
    content: &[u8],
    execution_id: &str,
    fault: FaultPoint,
    destination_race: bool,
) -> Result<MutationAttestation, MutationFailure> {
    let path = validate_public_path(path, PathLimits::default()).map_err(before_commit)?;
    let parent = open_verified_parent(root_fd, &path).map_err(before_commit)?;
    if !path_is_absent(parent.as_raw_fd(), path.basename()).map_err(before_commit)? {
        return Err(before_commit(SpikeError::DestinationExists));
    }
    let (_stage, ownership, hash) =
        create_stage(parent.as_raw_fd(), execution_id, content, None).map_err(before_commit)?;
    if let Err(error) = injected(
        fault,
        FaultPoint::BeforeRename,
        CommitCertainty::DefiniteNoMutation,
    ) {
        let _ = cleanup_owned(parent.as_raw_fd(), &ownership);
        return Err(error);
    }
    if destination_race {
        let destination = cstring(path.basename()).map_err(before_commit)?;
        // SAFETY: destination is validated, parent is held, and mode accompanies O_CREAT.
        let fd = unsafe {
            libc::openat(
                parent.as_raw_fd(),
                destination.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_CLOEXEC,
                0o600,
            )
        };
        if fd >= 0 {
            // SAFETY: openat returned a new owned descriptor.
            let mut file = unsafe { File::from_raw_fd(fd) };
            let _ = file.write_all(b"racing-writer");
            let _ = file.sync_all();
        }
    }
    if let Err(error) = renameat2(
        parent.as_raw_fd(),
        &ownership.name,
        parent.as_raw_fd(),
        path.basename(),
        RENAME_NOREPLACE,
    ) {
        let _ = cleanup_owned(parent.as_raw_fd(), &ownership);
        return Err(before_commit(match error {
            SpikeError::Io(io) if io.raw_os_error() == Some(libc::EEXIST) => {
                SpikeError::DestinationExists
            }
            other => other,
        }));
    }
    injected(
        fault,
        FaultPoint::AfterRename,
        CommitCertainty::MutationMayHaveOccurred,
    )?;
    injected(
        fault,
        FaultPoint::BeforeParentFsync,
        CommitCertainty::MutationMayHaveOccurred,
    )?;
    fsync_fd(parent.as_raw_fd())
        .map_err(|_| failure(CommitCertainty::MutationMayHaveOccurred, "parent_fsync"))?;
    injected(
        fault,
        FaultPoint::AfterParentFsync,
        CommitCertainty::MutationMayHaveOccurred,
    )?;
    Ok(MutationAttestation {
        certainty: CommitCertainty::DefiniteSuccess,
        content_sha256: Some(hash),
    })
}

pub fn write_file(
    root_fd: RawFd,
    path: &str,
    expected: &FileIdentity,
    content: &[u8],
    execution_id: &str,
    fault: FaultPoint,
) -> Result<MutationAttestation, MutationFailure> {
    let path = validate_public_path(path, PathLimits::default()).map_err(before_commit)?;
    let parent = open_verified_parent(root_fd, &path).map_err(before_commit)?;
    let mut source = open_regular(parent.as_raw_fd(), path.basename()).map_err(before_commit)?;
    let inspected = inspect_open_file(&mut source).map_err(before_commit)?;
    if &inspected != expected {
        return Err(before_commit(SpikeError::SourcePrecondition));
    }
    let (_stage, ownership, hash) =
        create_stage(parent.as_raw_fd(), execution_id, content, None).map_err(before_commit)?;
    let mut final_source =
        open_regular(parent.as_raw_fd(), path.basename()).map_err(before_commit)?;
    if inspect_open_file(&mut final_source).map_err(before_commit)? != *expected {
        let _ = cleanup_owned(parent.as_raw_fd(), &ownership);
        return Err(before_commit(SpikeError::SourcePrecondition));
    }
    if let Err(error) = injected(
        fault,
        FaultPoint::BeforeRename,
        CommitCertainty::DefiniteNoMutation,
    ) {
        let _ = cleanup_owned(parent.as_raw_fd(), &ownership);
        return Err(error);
    }
    renameat2(
        parent.as_raw_fd(),
        &ownership.name,
        parent.as_raw_fd(),
        path.basename(),
        0,
    )
    .map_err(before_commit)?;
    injected(
        fault,
        FaultPoint::AfterRename,
        CommitCertainty::MutationMayHaveOccurred,
    )?;
    injected(
        fault,
        FaultPoint::BeforeParentFsync,
        CommitCertainty::MutationMayHaveOccurred,
    )?;
    fsync_fd(parent.as_raw_fd())
        .map_err(|_| failure(CommitCertainty::MutationMayHaveOccurred, "parent_fsync"))?;
    injected(
        fault,
        FaultPoint::AfterParentFsync,
        CommitCertainty::MutationMayHaveOccurred,
    )?;
    Ok(MutationAttestation {
        certainty: CommitCertainty::DefiniteSuccess,
        content_sha256: Some(hash),
    })
}

pub fn move_file(
    root_fd: RawFd,
    source_path: &str,
    destination_path: &str,
    expected: &FileIdentity,
    fault: FaultPoint,
) -> Result<MutationAttestation, MutationFailure> {
    let source_path =
        validate_public_path(source_path, PathLimits::default()).map_err(before_commit)?;
    let destination_path =
        validate_public_path(destination_path, PathLimits::default()).map_err(before_commit)?;
    let source_parent = open_verified_parent(root_fd, &source_path).map_err(before_commit)?;
    let destination_parent =
        open_verified_parent(root_fd, &destination_path).map_err(before_commit)?;
    let source_parent_meta =
        File::from(duplicate_cloexec(source_parent.as_raw_fd()).map_err(before_commit)?)
            .metadata()
            .map_err(|error| before_commit(error.into()))?;
    let destination_parent_meta =
        File::from(duplicate_cloexec(destination_parent.as_raw_fd()).map_err(before_commit)?)
            .metadata()
            .map_err(|error| before_commit(error.into()))?;
    if source_parent_meta.dev() != destination_parent_meta.dev() {
        return Err(failure(CommitCertainty::DefiniteNoMutation, "cross_device"));
    }
    let mut source =
        open_regular(source_parent.as_raw_fd(), source_path.basename()).map_err(before_commit)?;
    if inspect_open_file(&mut source).map_err(before_commit)? != *expected {
        return Err(before_commit(SpikeError::SourcePrecondition));
    }
    if !path_is_absent(destination_parent.as_raw_fd(), destination_path.basename())
        .map_err(before_commit)?
    {
        return Err(before_commit(SpikeError::DestinationExists));
    }
    injected(
        fault,
        FaultPoint::BeforeRename,
        CommitCertainty::DefiniteNoMutation,
    )?;
    renameat2(
        source_parent.as_raw_fd(),
        source_path.basename(),
        destination_parent.as_raw_fd(),
        destination_path.basename(),
        RENAME_NOREPLACE,
    )
    .map_err(before_commit)?;
    injected(
        fault,
        FaultPoint::AfterRename,
        CommitCertainty::MutationMayHaveOccurred,
    )?;
    injected(
        fault,
        FaultPoint::BeforeParentFsync,
        CommitCertainty::MutationMayHaveOccurred,
    )?;
    fsync_fd(source_parent.as_raw_fd()).map_err(|_| {
        failure(
            CommitCertainty::MutationMayHaveOccurred,
            "source_parent_fsync",
        )
    })?;
    if source_parent_meta.ino() != destination_parent_meta.ino() {
        fsync_fd(destination_parent.as_raw_fd()).map_err(|_| {
            failure(
                CommitCertainty::MutationMayHaveOccurred,
                "destination_parent_fsync",
            )
        })?;
    }
    injected(
        fault,
        FaultPoint::AfterParentFsync,
        CommitCertainty::MutationMayHaveOccurred,
    )?;
    Ok(MutationAttestation {
        certainty: CommitCertainty::DefiniteSuccess,
        content_sha256: Some(expected.sha256.clone()),
    })
}

pub fn delete_file(
    root_fd: RawFd,
    path: &str,
    expected: &FileIdentity,
    execution_id: &str,
    forced_random: Option<&str>,
    fault: FaultPoint,
) -> Result<MutationAttestation, MutationFailure> {
    let path = validate_public_path(path, PathLimits::default()).map_err(before_commit)?;
    let parent = open_verified_parent(root_fd, &path).map_err(before_commit)?;
    let mut source = open_regular(parent.as_raw_fd(), path.basename()).map_err(before_commit)?;
    let inspected = inspect_open_file(&mut source).map_err(before_commit)?;
    if &inspected != expected {
        return Err(before_commit(SpikeError::SourcePrecondition));
    }
    let random = match forced_random {
        Some(value) => value.to_owned(),
        None => random_identity().map_err(before_commit)?,
    };
    let tombstone_name = internal_name(execution_id, &random).map_err(before_commit)?;
    if !path_is_absent(parent.as_raw_fd(), &tombstone_name).map_err(before_commit)? {
        return Err(before_commit(SpikeError::DestinationExists));
    }
    injected(
        fault,
        FaultPoint::BeforeRename,
        CommitCertainty::DefiniteNoMutation,
    )?;
    renameat2(
        parent.as_raw_fd(),
        path.basename(),
        parent.as_raw_fd(),
        &tombstone_name,
        RENAME_NOREPLACE,
    )
    .map_err(before_commit)?;
    let ownership = InternalOwnership {
        name: tombstone_name,
        execution_id: execution_id.to_owned(),
        random_identity: random,
        device: inspected.device,
        inode: inspected.inode,
    };
    injected(
        fault,
        FaultPoint::AfterRename,
        CommitCertainty::MutationMayHaveOccurred,
    )?;
    injected(
        fault,
        FaultPoint::BeforeParentFsync,
        CommitCertainty::MutationMayHaveOccurred,
    )?;
    fsync_fd(parent.as_raw_fd())
        .map_err(|_| failure(CommitCertainty::MutationMayHaveOccurred, "parent_fsync"))?;
    injected(
        fault,
        FaultPoint::BeforeTombstoneUnlink,
        CommitCertainty::MutationMayHaveOccurred,
    )?;
    cleanup_owned(parent.as_raw_fd(), &ownership).map_err(|_| {
        failure(
            CommitCertainty::MutationMayHaveOccurred,
            "tombstone_ownership",
        )
    })?;
    injected(
        fault,
        FaultPoint::AfterTombstoneUnlink,
        CommitCertainty::MutationMayHaveOccurred,
    )?;
    fsync_fd(parent.as_raw_fd())
        .map_err(|_| failure(CommitCertainty::MutationMayHaveOccurred, "parent_fsync"))?;
    injected(
        fault,
        FaultPoint::AfterParentFsync,
        CommitCertainty::MutationMayHaveOccurred,
    )?;
    Ok(MutationAttestation {
        certainty: CommitCertainty::DefiniteSuccess,
        content_sha256: Some(expected.sha256.clone()),
    })
}

pub fn hex_sha256(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[doc(hidden)]
pub fn create_stage_for_test(
    parent_fd: RawFd,
    execution_id: &str,
    content: &[u8],
    forced_random: &str,
) -> Result<InternalOwnership, SpikeError> {
    let (_file, ownership, _hash) =
        create_stage(parent_fd, execution_id, content, Some(forced_random))?;
    Ok(ownership)
}
