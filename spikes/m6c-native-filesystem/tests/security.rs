#![cfg(target_os = "linux")]

use m6c_native_filesystem_spike::linux::{
    open_directory, openat2_beneath, openat2_with_resolve, renameat2, root_identity,
    REQUIRED_RESOLVE_FLAGS, RESOLVE_BENEATH, RESOLVE_NO_MAGICLINKS,
};
use m6c_native_filesystem_spike::mutations::{
    cleanup_owned, create_file, create_stage_for_test, delete_file, inspect_path, move_file,
    write_file, CommitCertainty, FaultPoint,
};
use m6c_native_filesystem_spike::{probe_capabilities, require_capabilities, SpikeError};
use std::ffi::CString;
use std::fs::File;
use std::os::fd::AsRawFd;
use std::os::unix::fs::symlink;

fn io_errno(error: SpikeError) -> Option<i32> {
    match error {
        SpikeError::Io(error) => error.raw_os_error(),
        _ => None,
    }
}

#[test]
fn capability_probe_is_behavioral_and_fail_closed() {
    let probe = probe_capabilities();
    assert!(probe.openat2, "{:?}", probe.failures);
    assert!(probe.required_resolve_flags, "{:?}", probe.failures);
    assert!(probe.renameat2, "{:?}", probe.failures);
    assert!(probe.rename_noreplace, "{:?}", probe.failures);
    assert!(probe.statx, "{:?}", probe.failures);
    assert_ne!(probe.mount_identity, "unavailable");
    assert!(probe.directory_fsync, "{:?}", probe.failures);
    assert!(probe.unlinkat, "{:?}", probe.failures);
    assert!(probe.close_on_exec, "{:?}", probe.failures);
    assert!(probe.no_follow, "{:?}", probe.failures);
    assert!(probe.exclusive_create, "{:?}", probe.failures);
    assert!(probe.supported, "{:?}", probe.failures);
    require_capabilities(&probe).unwrap();
}

#[test]
fn unsupported_required_flag_fails_without_fallback() {
    let directory = tempfile::tempdir().unwrap();
    let root = open_directory(directory.path()).unwrap();
    let unknown_resolve_flag = 1_u64 << 63;
    let error = openat2_with_resolve(
        root.as_raw_fd(),
        ".",
        libc::O_RDONLY | libc::O_DIRECTORY,
        REQUIRED_RESOLVE_FLAGS | unknown_resolve_flag,
    )
    .unwrap_err();
    assert_eq!(io_errno(error), Some(libc::EINVAL));
}

#[test]
fn openat2_denies_traversal_absolute_and_symlink_paths() {
    let directory = tempfile::tempdir().unwrap();
    std::fs::create_dir(directory.path().join("child")).unwrap();
    std::fs::write(directory.path().join("child/file"), b"safe").unwrap();
    symlink("child/file", directory.path().join("link")).unwrap();
    let root = open_directory(directory.path()).unwrap();

    openat2_beneath(root.as_raw_fd(), "child/file", libc::O_RDONLY, 0).unwrap();
    for denied in ["../etc/passwd", "/etc/passwd", "link"] {
        assert!(openat2_beneath(root.as_raw_fd(), denied, libc::O_RDONLY, 0).is_err());
    }
}

#[test]
fn openat2_denies_magic_links() {
    let target = File::open("/etc/hosts").unwrap();
    let proc_fds = open_directory(std::path::Path::new("/proc/self/fd")).unwrap();
    let error = openat2_with_resolve(
        proc_fds.as_raw_fd(),
        &target.as_raw_fd().to_string(),
        libc::O_RDONLY,
        RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS,
    )
    .unwrap_err();
    assert_eq!(io_errno(error), Some(libc::ELOOP));
}

#[test]
fn no_xdev_denies_existing_cross_mount_traversal() {
    let root = open_directory(std::path::Path::new("/")).unwrap();
    let error = openat2_beneath(root.as_raw_fd(), "proc/version", libc::O_RDONLY, 0).unwrap_err();
    assert_eq!(io_errno(error), Some(libc::EXDEV));
}

#[test]
fn root_identity_detects_path_substitution_and_identical_bytes() {
    let parent = tempfile::tempdir().unwrap();
    let registered = parent.path().join("workspace");
    let replacement = parent.path().join("replacement");
    std::fs::create_dir(&registered).unwrap();
    std::fs::create_dir(&replacement).unwrap();
    std::fs::write(registered.join("same.txt"), b"identical").unwrap();
    std::fs::write(replacement.join("same.txt"), b"identical").unwrap();

    let simulation_fd = open_directory(&registered).unwrap();
    let simulation_identity = root_identity(simulation_fd.as_raw_fd()).unwrap();
    let reopened = open_directory(&registered).unwrap();
    assert_eq!(
        simulation_identity,
        root_identity(reopened.as_raw_fd()).unwrap()
    );

    std::fs::rename(&registered, parent.path().join("old-workspace")).unwrap();
    std::fs::rename(&replacement, &registered).unwrap();
    let execution_fd = open_directory(&registered).unwrap();
    assert_eq!(
        std::fs::read(registered.join("same.txt")).unwrap(),
        b"identical"
    );
    assert_ne!(
        simulation_identity,
        root_identity(execution_fd.as_raw_fd()).unwrap()
    );
}

#[test]
fn create_write_move_delete_use_parent_descriptors() {
    let directory = tempfile::tempdir().unwrap();
    std::fs::create_dir(directory.path().join("a")).unwrap();
    std::fs::create_dir(directory.path().join("b")).unwrap();
    let root = open_directory(directory.path()).unwrap();

    let created = create_file(
        root.as_raw_fd(),
        "a/file.txt",
        b"created",
        "exec-create",
        FaultPoint::None,
        false,
    )
    .unwrap();
    assert_eq!(created.certainty, CommitCertainty::DefiniteSuccess);
    assert_eq!(
        std::fs::read(directory.path().join("a/file.txt")).unwrap(),
        b"created"
    );

    let source = inspect_path(root.as_raw_fd(), "a/file.txt").unwrap();
    let written = write_file(
        root.as_raw_fd(),
        "a/file.txt",
        &source,
        b"written",
        "exec-write",
        FaultPoint::None,
    )
    .unwrap();
    assert_eq!(written.certainty, CommitCertainty::DefiniteSuccess);

    let moved_source = inspect_path(root.as_raw_fd(), "a/file.txt").unwrap();
    let moved = move_file(
        root.as_raw_fd(),
        "a/file.txt",
        "b/file.txt",
        &moved_source,
        FaultPoint::None,
    )
    .unwrap();
    assert_eq!(moved.certainty, CommitCertainty::DefiniteSuccess);
    assert!(!directory.path().join("a/file.txt").exists());

    let deleted_source = inspect_path(root.as_raw_fd(), "b/file.txt").unwrap();
    let deleted = delete_file(
        root.as_raw_fd(),
        "b/file.txt",
        &deleted_source,
        "exec-delete",
        Some("deadbeef"),
        FaultPoint::None,
    )
    .unwrap();
    assert_eq!(deleted.certainty, CommitCertainty::DefiniteSuccess);
    assert!(!directory.path().join("b/file.txt").exists());
}

#[test]
fn destination_race_is_denied_without_overwrite() {
    let directory = tempfile::tempdir().unwrap();
    let root = open_directory(directory.path()).unwrap();
    let error = create_file(
        root.as_raw_fd(),
        "destination",
        b"approved",
        "exec-race",
        FaultPoint::None,
        true,
    )
    .unwrap_err();
    assert_eq!(error.certainty, CommitCertainty::DefiniteNoMutation);
    assert_eq!(error.code, "destination_exists");
    assert_eq!(
        std::fs::read(directory.path().join("destination")).unwrap(),
        b"racing-writer"
    );
}

#[test]
fn hard_links_and_special_files_are_denied_nonblocking() {
    let directory = tempfile::tempdir().unwrap();
    std::fs::write(directory.path().join("source"), b"linked").unwrap();
    std::fs::hard_link(
        directory.path().join("source"),
        directory.path().join("alias"),
    )
    .unwrap();
    let fifo = CString::new(directory.path().join("fifo").to_str().unwrap()).unwrap();
    // SAFETY: fifo path is a valid C string in the temporary fixture.
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    let root = open_directory(directory.path()).unwrap();
    assert!(matches!(
        inspect_path(root.as_raw_fd(), "source"),
        Err(SpikeError::UnsafeFileType)
    ));
    assert!(matches!(
        inspect_path(root.as_raw_fd(), "fifo"),
        Err(SpikeError::UnsafeFileType)
    ));
}

#[test]
fn internal_collision_and_uncertain_ownership_never_delete() {
    let directory = tempfile::tempdir().unwrap();
    let root = open_directory(directory.path()).unwrap();
    let ownership = create_stage_for_test(root.as_raw_fd(), "exec", b"owned", "deadbeef").unwrap();

    assert!(create_stage_for_test(root.as_raw_fd(), "exec", b"second", "deadbeef").is_err());

    let mut wrong_execution = ownership.clone();
    wrong_execution.execution_id = "other".to_owned();
    assert!(matches!(
        cleanup_owned(root.as_raw_fd(), &wrong_execution),
        Err(SpikeError::OwnershipUncertain)
    ));
    assert!(directory.path().join(&ownership.name).exists());

    std::fs::remove_file(directory.path().join(&ownership.name)).unwrap();
    std::fs::write(
        directory.path().join(&ownership.name),
        b"hostile replacement",
    )
    .unwrap();
    assert!(matches!(
        cleanup_owned(root.as_raw_fd(), &ownership),
        Err(SpikeError::OwnershipUncertain)
    ));
    assert_eq!(
        std::fs::read(directory.path().join(&ownership.name)).unwrap(),
        b"hostile replacement"
    );
}

#[test]
fn delete_collision_does_not_touch_source_or_hostile_entry() {
    let directory = tempfile::tempdir().unwrap();
    std::fs::write(directory.path().join("target"), b"target").unwrap();
    std::fs::write(
        directory.path().join(".ai-office-txn-exec-deadbeef"),
        b"hostile",
    )
    .unwrap();
    let root = open_directory(directory.path()).unwrap();
    let source = inspect_path(root.as_raw_fd(), "target").unwrap();
    let error = delete_file(
        root.as_raw_fd(),
        "target",
        &source,
        "exec",
        Some("deadbeef"),
        FaultPoint::None,
    )
    .unwrap_err();
    assert_eq!(error.certainty, CommitCertainty::DefiniteNoMutation);
    assert_eq!(
        std::fs::read(directory.path().join("target")).unwrap(),
        b"target"
    );
    assert_eq!(
        std::fs::read(directory.path().join(".ai-office-txn-exec-deadbeef")).unwrap(),
        b"hostile"
    );
}

#[test]
fn fault_points_report_target_mutation_certainty() {
    let directory = tempfile::tempdir().unwrap();
    let root = open_directory(directory.path()).unwrap();

    let before = create_file(
        root.as_raw_fd(),
        "before",
        b"bytes",
        "exec-before",
        FaultPoint::BeforeRename,
        false,
    )
    .unwrap_err();
    assert_eq!(before.certainty, CommitCertainty::DefiniteNoMutation);
    assert!(!directory.path().join("before").exists());

    for (name, point) in [
        ("after-rename", FaultPoint::AfterRename),
        ("before-fsync", FaultPoint::BeforeParentFsync),
        ("after-fsync", FaultPoint::AfterParentFsync),
    ] {
        let error = create_file(root.as_raw_fd(), name, b"bytes", name, point, false).unwrap_err();
        assert_eq!(error.certainty, CommitCertainty::MutationMayHaveOccurred);
        assert!(directory.path().join(name).exists());
    }

    std::fs::write(directory.path().join("delete-before-unlink"), b"delete").unwrap();
    let source = inspect_path(root.as_raw_fd(), "delete-before-unlink").unwrap();
    let error = delete_file(
        root.as_raw_fd(),
        "delete-before-unlink",
        &source,
        "delete",
        Some("aabb"),
        FaultPoint::BeforeTombstoneUnlink,
    )
    .unwrap_err();
    assert_eq!(error.certainty, CommitCertainty::MutationMayHaveOccurred);
    assert!(!directory.path().join("delete-before-unlink").exists());
    assert!(directory.path().join(".ai-office-txn-delete-aabb").exists());

    std::fs::write(directory.path().join("delete-after-unlink"), b"delete").unwrap();
    let source = inspect_path(root.as_raw_fd(), "delete-after-unlink").unwrap();
    let error = delete_file(
        root.as_raw_fd(),
        "delete-after-unlink",
        &source,
        "delete2",
        Some("ccdd"),
        FaultPoint::AfterTombstoneUnlink,
    )
    .unwrap_err();
    assert_eq!(error.certainty, CommitCertainty::MutationMayHaveOccurred);
    assert!(!directory.path().join("delete-after-unlink").exists());
    assert!(!directory
        .path()
        .join(".ai-office-txn-delete2-ccdd")
        .exists());
}

#[test]
fn write_and_move_faults_preserve_certainty_contract() {
    let directory = tempfile::tempdir().unwrap();
    std::fs::create_dir(directory.path().join("source-parent")).unwrap();
    std::fs::create_dir(directory.path().join("destination-parent")).unwrap();
    let root = open_directory(directory.path()).unwrap();

    std::fs::write(directory.path().join("write-before"), b"old").unwrap();
    let before_identity = inspect_path(root.as_raw_fd(), "write-before").unwrap();
    let before = write_file(
        root.as_raw_fd(),
        "write-before",
        &before_identity,
        b"new",
        "write-before",
        FaultPoint::BeforeRename,
    )
    .unwrap_err();
    assert_eq!(before.certainty, CommitCertainty::DefiniteNoMutation);
    assert_eq!(
        std::fs::read(directory.path().join("write-before")).unwrap(),
        b"old"
    );

    std::fs::write(directory.path().join("write-after"), b"old").unwrap();
    let after_identity = inspect_path(root.as_raw_fd(), "write-after").unwrap();
    let after = write_file(
        root.as_raw_fd(),
        "write-after",
        &after_identity,
        b"new",
        "write-after",
        FaultPoint::AfterRename,
    )
    .unwrap_err();
    assert_eq!(after.certainty, CommitCertainty::MutationMayHaveOccurred);
    assert_eq!(
        std::fs::read(directory.path().join("write-after")).unwrap(),
        b"new"
    );

    std::fs::write(directory.path().join("source-parent/before"), b"move").unwrap();
    let move_before_identity = inspect_path(root.as_raw_fd(), "source-parent/before").unwrap();
    let move_before = move_file(
        root.as_raw_fd(),
        "source-parent/before",
        "destination-parent/before",
        &move_before_identity,
        FaultPoint::BeforeRename,
    )
    .unwrap_err();
    assert_eq!(move_before.certainty, CommitCertainty::DefiniteNoMutation);
    assert!(directory.path().join("source-parent/before").exists());
    assert!(!directory.path().join("destination-parent/before").exists());

    std::fs::write(directory.path().join("source-parent/after"), b"move").unwrap();
    let move_after_identity = inspect_path(root.as_raw_fd(), "source-parent/after").unwrap();
    let move_after = move_file(
        root.as_raw_fd(),
        "source-parent/after",
        "destination-parent/after",
        &move_after_identity,
        FaultPoint::AfterRename,
    )
    .unwrap_err();
    assert_eq!(
        move_after.certainty,
        CommitCertainty::MutationMayHaveOccurred
    );
    assert!(!directory.path().join("source-parent/after").exists());
    assert_eq!(
        std::fs::read(directory.path().join("destination-parent/after")).unwrap(),
        b"move"
    );
}

#[test]
fn renameat2_cross_device_fails_without_copy_delete() {
    if !std::path::Path::new("/dev/shm").is_dir() {
        eprintln!("UNVERIFIED: /dev/shm is unavailable");
        return;
    }
    let source_dir = tempfile::tempdir().unwrap();
    let destination_dir = tempfile::tempdir_in("/dev/shm").unwrap();
    std::fs::write(source_dir.path().join("source"), b"source").unwrap();
    let source_parent = open_directory(source_dir.path()).unwrap();
    let destination_parent = open_directory(destination_dir.path()).unwrap();
    let error = renameat2(
        source_parent.as_raw_fd(),
        "source",
        destination_parent.as_raw_fd(),
        "destination",
        1,
    )
    .unwrap_err();
    assert_eq!(io_errno(error), Some(libc::EXDEV));
    assert!(source_dir.path().join("source").exists());
    assert!(!destination_dir.path().join("destination").exists());
}

#[test]
#[ignore = "requires a privileged Linux mount namespace; run explicitly with M6C_RUN_PRIVILEGED_MOUNT_TESTS=1"]
fn privileged_mount_root_identity_and_no_xdev() {
    if std::env::var("M6C_RUN_PRIVILEGED_MOUNT_TESTS").as_deref() != Ok("1") {
        eprintln!("UNVERIFIED: privileged mount test was not requested");
        return;
    }
    let directory = tempfile::tempdir().unwrap();
    let mountpoint = directory.path().join("root");
    let child_mount = mountpoint.join("child-mount");
    let bind_source = directory.path().join("bind-source");
    let bind_target = mountpoint.join("bind-target");
    std::fs::create_dir(&mountpoint).unwrap();
    std::fs::create_dir(&bind_source).unwrap();

    mount_tmpfs(&mountpoint);
    std::fs::create_dir(&child_mount).unwrap();
    std::fs::create_dir(&bind_target).unwrap();
    let first_fd = open_directory(&mountpoint).unwrap();
    let first_identity = root_identity(first_fd.as_raw_fd()).unwrap();

    mount_tmpfs(&child_mount);
    let child_error = openat2_beneath(
        first_fd.as_raw_fd(),
        "child-mount",
        libc::O_RDONLY | libc::O_DIRECTORY,
        0,
    )
    .unwrap_err();
    assert_eq!(io_errno(child_error), Some(libc::EXDEV));
    unmount(&child_mount);

    bind_mount(&bind_source, &bind_target);
    let bind_error = openat2_beneath(
        first_fd.as_raw_fd(),
        "bind-target",
        libc::O_RDONLY | libc::O_DIRECTORY,
        0,
    )
    .unwrap_err();
    assert_eq!(io_errno(bind_error), Some(libc::EXDEV));
    unmount(&bind_target);

    drop(first_fd);
    unmount(&mountpoint);
    mount_tmpfs(&mountpoint);
    let second_fd = open_directory(&mountpoint).unwrap();
    let second_identity = root_identity(second_fd.as_raw_fd()).unwrap();
    assert_ne!(first_identity, second_identity);
    unmount(&mountpoint);
}

fn mount_tmpfs(path: &std::path::Path) {
    let source = CString::new("m6c-spike").unwrap();
    let target = CString::new(path.to_str().unwrap()).unwrap();
    let filesystem = CString::new("tmpfs").unwrap();
    // SAFETY: strings live for the call; data is null and this runs only in the privileged fixture.
    let result = unsafe {
        libc::mount(
            source.as_ptr(),
            target.as_ptr(),
            filesystem.as_ptr(),
            libc::MS_NOSUID | libc::MS_NODEV,
            std::ptr::null(),
        )
    };
    assert_eq!(
        result,
        0,
        "mount failed: {}",
        std::io::Error::last_os_error()
    );
}

fn bind_mount(source: &std::path::Path, target: &std::path::Path) {
    let source = CString::new(source.to_str().unwrap()).unwrap();
    let target = CString::new(target.to_str().unwrap()).unwrap();
    // SAFETY: strings live for the call and MS_BIND ignores filesystem/data.
    let result = unsafe {
        libc::mount(
            source.as_ptr(),
            target.as_ptr(),
            std::ptr::null(),
            libc::MS_BIND,
            std::ptr::null(),
        )
    };
    assert_eq!(
        result,
        0,
        "bind mount failed: {}",
        std::io::Error::last_os_error()
    );
}

fn unmount(path: &std::path::Path) {
    let target = CString::new(path.to_str().unwrap()).unwrap();
    // SAFETY: target lives for the call and names only the temporary fixture mount.
    let result = unsafe { libc::umount2(target.as_ptr(), libc::MNT_DETACH) };
    assert_eq!(
        result,
        0,
        "unmount failed: {}",
        std::io::Error::last_os_error()
    );
}
