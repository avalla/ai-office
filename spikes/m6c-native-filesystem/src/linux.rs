#![cfg(target_os = "linux")]

use crate::{CapabilityProbe, MountIdentityKind, RootIdentity, SpikeError};
use std::ffi::CString;
use std::fs::File;
use std::io::Write;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::fs::symlink;
use std::path::Path;

pub const RESOLVE_NO_XDEV: u64 = 0x01;
pub const RESOLVE_NO_MAGICLINKS: u64 = 0x02;
pub const RESOLVE_NO_SYMLINKS: u64 = 0x04;
pub const RESOLVE_BENEATH: u64 = 0x08;
pub const REQUIRED_RESOLVE_FLAGS: u64 =
    RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV;
pub const RENAME_NOREPLACE: u32 = 1;
const STATX_BASIC_STATS: u32 = 0x0000_07ff;
const STATX_MNT_ID: u32 = 0x0000_1000;
const STATX_MNT_ID_UNIQUE: u32 = 0x0000_4000;

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct OpenHow {
    flags: u64,
    mode: u64,
    resolve: u64,
}

fn cstring(value: &str) -> Result<CString, SpikeError> {
    CString::new(value).map_err(|_| SpikeError::InvalidPath("path contains NUL"))
}

pub fn open_directory(path: &Path) -> Result<OwnedFd, SpikeError> {
    let path = cstring(
        path.to_str()
            .ok_or(SpikeError::InvalidPath("path is not UTF-8"))?,
    )?;
    // SAFETY: path is a live NUL-terminated CString and flags require no variadic mode.
    let fd = unsafe {
        libc::open(
            path.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
    };
    if fd < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    // SAFETY: open returned a new owned descriptor.
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

pub fn duplicate_cloexec(fd: RawFd) -> Result<OwnedFd, SpikeError> {
    // SAFETY: fcntl duplicates a valid caller-owned descriptor.
    let duplicated = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 0) };
    if duplicated < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    // SAFETY: fcntl returned a new owned descriptor.
    Ok(unsafe { OwnedFd::from_raw_fd(duplicated) })
}

fn openat2_once(
    dirfd: RawFd,
    path: &CString,
    flags: i32,
    mode: u32,
    resolve: u64,
) -> std::io::Result<RawFd> {
    let how = OpenHow {
        flags: flags as u64,
        mode: mode as u64,
        resolve,
    };
    // SAFETY: all pointers reference initialized values for the duration of the syscall.
    let result = unsafe {
        libc::syscall(
            libc::SYS_openat2,
            dirfd,
            path.as_ptr(),
            &how as *const OpenHow,
            std::mem::size_of::<OpenHow>(),
        )
    } as RawFd;
    if result < 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(result)
    }
}

pub fn retry_eagain<T>(mut operation: impl FnMut() -> std::io::Result<T>) -> std::io::Result<T> {
    for attempt in 0..2 {
        match operation() {
            Err(error) if error.raw_os_error() == Some(libc::EAGAIN) && attempt == 0 => continue,
            result => return result,
        }
    }
    unreachable!("the retry loop has exactly two terminating attempts")
}

pub fn openat2_beneath(
    dirfd: RawFd,
    path: &str,
    flags: i32,
    mode: u32,
) -> Result<OwnedFd, SpikeError> {
    let path = cstring(path)?;
    let fd = retry_eagain(|| {
        openat2_once(
            dirfd,
            &path,
            flags | libc::O_CLOEXEC,
            mode,
            REQUIRED_RESOLVE_FLAGS,
        )
    })?;
    // SAFETY: openat2 returned a new owned descriptor.
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

pub fn openat2_with_resolve(
    dirfd: RawFd,
    path: &str,
    flags: i32,
    resolve: u64,
) -> Result<OwnedFd, SpikeError> {
    let path = cstring(path)?;
    let fd = retry_eagain(|| openat2_once(dirfd, &path, flags | libc::O_CLOEXEC, 0, resolve))?;
    // SAFETY: openat2 returned a new owned descriptor.
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

fn statx_identity_with_mask(fd: RawFd, mask: u32) -> Result<(RootIdentity, u32), SpikeError> {
    let empty = cstring("")?;
    // SAFETY: libc::statx is a plain data struct and zero is a valid initialization.
    let mut stat: libc::statx = unsafe { std::mem::zeroed() };
    // SAFETY: empty path with AT_EMPTY_PATH operates on fd; stat points to writable storage.
    let result = unsafe {
        libc::statx(
            fd,
            empty.as_ptr(),
            libc::AT_EMPTY_PATH | libc::AT_SYMLINK_NOFOLLOW,
            STATX_BASIC_STATS | mask,
            &mut stat,
        )
    };
    if result < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let kind = if stat.stx_mask & STATX_MNT_ID_UNIQUE != 0 {
        MountIdentityKind::StatxMountIdUnique
    } else if stat.stx_mask & STATX_MNT_ID != 0 {
        MountIdentityKind::StatxMountId
    } else {
        MountIdentityKind::Unavailable
    };
    Ok((
        RootIdentity {
            device_major: stat.stx_dev_major,
            device_minor: stat.stx_dev_minor,
            inode: stat.stx_ino,
            mount_id: stat.stx_mnt_id,
            mount_identity_kind: kind,
        },
        stat.stx_mask,
    ))
}

pub fn root_identity(fd: RawFd) -> Result<RootIdentity, SpikeError> {
    let (unique, unique_mask) = statx_identity_with_mask(fd, STATX_MNT_ID_UNIQUE)?;
    if unique_mask & STATX_MNT_ID_UNIQUE != 0 {
        return Ok(unique);
    }
    let (ordinary, ordinary_mask) = statx_identity_with_mask(fd, STATX_MNT_ID)?;
    if ordinary_mask & STATX_MNT_ID != 0 {
        return Ok(ordinary);
    }
    Err(SpikeError::Unsupported(
        "statx mount identity is unavailable",
    ))
}

pub fn renameat2(
    old_dirfd: RawFd,
    old_name: &str,
    new_dirfd: RawFd,
    new_name: &str,
    flags: u32,
) -> Result<(), SpikeError> {
    let old_name = cstring(old_name)?;
    let new_name = cstring(new_name)?;
    // SAFETY: both names are valid C strings and dirfds are caller-held.
    let result = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            old_dirfd,
            old_name.as_ptr(),
            new_dirfd,
            new_name.as_ptr(),
            flags,
        )
    };
    if result < 0 {
        Err(std::io::Error::last_os_error().into())
    } else {
        Ok(())
    }
}

pub fn unlinkat(dirfd: RawFd, name: &str) -> Result<(), SpikeError> {
    let name = cstring(name)?;
    // SAFETY: name is a valid C string and dirfd is caller-held.
    let result = unsafe { libc::unlinkat(dirfd, name.as_ptr(), 0) };
    if result < 0 {
        Err(std::io::Error::last_os_error().into())
    } else {
        Ok(())
    }
}

pub fn fsync_fd(fd: RawFd) -> Result<(), SpikeError> {
    // SAFETY: fsync does not outlive the caller-held descriptor.
    if unsafe { libc::fsync(fd) } < 0 {
        Err(std::io::Error::last_os_error().into())
    } else {
        Ok(())
    }
}

fn check_cloexec(fd: RawFd) -> bool {
    // SAFETY: F_GETFD observes flags on a live descriptor.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
    flags >= 0 && flags & libc::FD_CLOEXEC != 0
}

pub fn probe_capabilities_internal() -> CapabilityProbe {
    let mut failures = Vec::new();
    let directory = match tempfile::tempdir() {
        Ok(value) => value,
        Err(error) => return CapabilityProbe::unsupported(format!("tempdir: {error}")),
    };
    let root = match open_directory(directory.path()) {
        Ok(value) => value,
        Err(error) => return CapabilityProbe::unsupported(format!("open root: {error}")),
    };

    let openat2 =
        openat2_with_resolve(root.as_raw_fd(), ".", libc::O_RDONLY | libc::O_DIRECTORY, 0).is_ok();
    if !openat2 {
        failures.push("openat2 unavailable".to_owned());
    }
    let required_resolve_flags =
        openat2_beneath(root.as_raw_fd(), ".", libc::O_RDONLY | libc::O_DIRECTORY, 0).is_ok();
    if !required_resolve_flags {
        failures.push("required openat2 resolve policy unavailable".to_owned());
    }

    let mount_identity = match root_identity(root.as_raw_fd()) {
        Ok(identity) => identity.mount_identity_kind,
        Err(error) => {
            failures.push(format!("statx mount identity: {error}"));
            MountIdentityKind::Unavailable
        }
    };
    let statx = mount_identity != MountIdentityKind::Unavailable;

    let source = directory.path().join("rename-source");
    let destination = directory.path().join("rename-destination");
    let _ = std::fs::write(&source, b"source");
    let _ = std::fs::write(&destination, b"destination");
    let rename_result = renameat2(
        root.as_raw_fd(),
        "rename-source",
        root.as_raw_fd(),
        "rename-destination",
        RENAME_NOREPLACE,
    );
    let renameat2_available = match &rename_result {
        Ok(()) => true,
        Err(SpikeError::Io(error)) => error.raw_os_error() != Some(libc::ENOSYS),
        Err(_) => false,
    };
    let rename_noreplace = matches!(
        &rename_result,
        Err(SpikeError::Io(error)) if error.raw_os_error() == Some(libc::EEXIST)
    ) && std::fs::read(&destination).ok().as_deref() == Some(b"destination")
        && source.exists();
    if !renameat2_available {
        failures.push("renameat2 unavailable".to_owned());
    }
    if !rename_noreplace {
        failures.push("RENAME_NOREPLACE behavior unavailable".to_owned());
    }

    let directory_fsync = fsync_fd(root.as_raw_fd()).is_ok();
    if !directory_fsync {
        failures.push("directory fsync unavailable".to_owned());
    }

    let unlink_path = directory.path().join("unlink-probe");
    let _ = std::fs::write(&unlink_path, b"unlink");
    let unlinkat_available =
        unlinkat(root.as_raw_fd(), "unlink-probe").is_ok() && !unlink_path.exists();
    if !unlinkat_available {
        failures.push("unlinkat unavailable".to_owned());
    }

    let close_on_exec = check_cloexec(root.as_raw_fd());
    if !close_on_exec {
        failures.push("O_CLOEXEC not observed".to_owned());
    }

    let target = directory.path().join("target");
    let link = directory.path().join("link");
    let _ = std::fs::write(&target, b"target");
    let _ = symlink("target", &link);
    let link_name = cstring("link").expect("constant contains no NUL");
    // SAFETY: link_name is valid and root is held; no variadic mode is required.
    let nofollow_result = unsafe {
        libc::openat(
            root.as_raw_fd(),
            link_name.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    let no_follow = if nofollow_result >= 0 {
        // SAFETY: this branch owns the returned descriptor.
        drop(unsafe { OwnedFd::from_raw_fd(nofollow_result) });
        false
    } else {
        std::io::Error::last_os_error().raw_os_error() == Some(libc::ELOOP)
    };
    if !no_follow {
        failures.push("O_NOFOLLOW behavior unavailable".to_owned());
    }

    let exclusive_name = cstring("exclusive").expect("constant contains no NUL");
    let create_flags = libc::O_RDWR | libc::O_CREAT | libc::O_EXCL | libc::O_CLOEXEC;
    // SAFETY: valid name, held parent fd, and a mode is supplied for O_CREAT.
    let first = unsafe {
        libc::openat(
            root.as_raw_fd(),
            exclusive_name.as_ptr(),
            create_flags,
            0o600,
        )
    };
    if first >= 0 {
        // SAFETY: openat returned a new descriptor.
        let mut file = unsafe { File::from_raw_fd(first) };
        let _ = file.write_all(b"exclusive");
    }
    // SAFETY: same valid arguments as the first exclusive create.
    let second = unsafe {
        libc::openat(
            root.as_raw_fd(),
            exclusive_name.as_ptr(),
            create_flags,
            0o600,
        )
    };
    let exclusive_create =
        second < 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::EEXIST);
    if second >= 0 {
        // SAFETY: openat returned a new descriptor.
        drop(unsafe { OwnedFd::from_raw_fd(second) });
    }
    if !exclusive_create {
        failures.push("O_CREAT|O_EXCL behavior unavailable".to_owned());
    }

    CapabilityProbe {
        platform: "linux".to_owned(),
        architecture: std::env::consts::ARCH.to_owned(),
        supported: failures.is_empty(),
        openat2,
        required_resolve_flags,
        renameat2: renameat2_available,
        rename_noreplace,
        statx,
        mount_identity: mount_identity.as_str().to_owned(),
        directory_fsync,
        unlinkat: unlinkat_available,
        close_on_exec,
        no_follow,
        exclusive_create,
        failures,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn eagain_retries_once_then_fails_closed() {
        let attempts = Cell::new(0);
        let result: std::io::Result<()> = retry_eagain(|| {
            attempts.set(attempts.get() + 1);
            Err(std::io::Error::from_raw_os_error(libc::EAGAIN))
        });
        assert_eq!(attempts.get(), 2);
        assert_eq!(result.unwrap_err().raw_os_error(), Some(libc::EAGAIN));
    }

    #[test]
    fn eagain_succeeds_on_only_retry() {
        let attempts = Cell::new(0);
        let result = retry_eagain(|| {
            attempts.set(attempts.get() + 1);
            if attempts.get() == 1 {
                Err(std::io::Error::from_raw_os_error(libc::EAGAIN))
            } else {
                Ok(7)
            }
        });
        assert_eq!(result.unwrap(), 7);
        assert_eq!(attempts.get(), 2);
    }
}
