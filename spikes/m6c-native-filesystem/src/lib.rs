#![deny(unsafe_op_in_unsafe_fn)]

mod path_validation;

#[cfg(target_os = "linux")]
pub mod linux;
#[cfg(target_os = "linux")]
pub mod mutations;

use napi_derive::napi;
use serde::{Deserialize, Serialize};
use thiserror::Error;

pub use path_validation::{validate_public_path, PathLimits, ValidatedPath};

#[derive(Debug, Error)]
pub enum SpikeError {
    #[error("unsupported capability: {0}")]
    Unsupported(&'static str),
    #[error("invalid relative path: {0}")]
    InvalidPath(&'static str),
    #[error("stale filesystem root identity")]
    StaleRootIdentity,
    #[error("source precondition mismatch")]
    SourcePrecondition,
    #[error("destination already exists")]
    DestinationExists,
    #[error("not a regular single-link file")]
    UnsafeFileType,
    #[error("internal entry ownership is not proven")]
    OwnershipUncertain,
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MountIdentityKind {
    StatxMountIdUnique,
    StatxMountId,
    Unavailable,
}

impl MountIdentityKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::StatxMountIdUnique => "statx_mnt_id_unique",
            Self::StatxMountId => "statx_mnt_id",
            Self::Unavailable => "unavailable",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct RootIdentity {
    pub device_major: u32,
    pub device_minor: u32,
    pub inode: u64,
    pub mount_id: u64,
    pub mount_identity_kind: MountIdentityKind,
}

#[napi(object)]
pub struct CapabilityProbe {
    pub platform: String,
    pub architecture: String,
    pub supported: bool,
    pub openat2: bool,
    pub required_resolve_flags: bool,
    pub renameat2: bool,
    pub rename_noreplace: bool,
    pub statx: bool,
    pub mount_identity: String,
    pub directory_fsync: bool,
    pub unlinkat: bool,
    pub close_on_exec: bool,
    pub no_follow: bool,
    pub exclusive_create: bool,
    pub failures: Vec<String>,
}

impl CapabilityProbe {
    fn unsupported(reason: String) -> Self {
        Self {
            platform: std::env::consts::OS.to_owned(),
            architecture: std::env::consts::ARCH.to_owned(),
            supported: false,
            openat2: false,
            required_resolve_flags: false,
            renameat2: false,
            rename_noreplace: false,
            statx: false,
            mount_identity: MountIdentityKind::Unavailable.as_str().to_owned(),
            directory_fsync: false,
            unlinkat: false,
            close_on_exec: false,
            no_follow: false,
            exclusive_create: false,
            failures: vec![reason],
        }
    }
}

#[napi]
pub fn probe_capabilities() -> CapabilityProbe {
    #[cfg(target_os = "linux")]
    {
        linux::probe_capabilities_internal()
    }
    #[cfg(not(target_os = "linux"))]
    {
        CapabilityProbe::unsupported("Linux is required; no fallback is available".to_owned())
    }
}

pub fn require_capabilities(probe: &CapabilityProbe) -> Result<(), SpikeError> {
    if probe.supported {
        Ok(())
    } else {
        Err(SpikeError::Unsupported(
            "required Linux native capability set is unavailable",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_identity_requires_all_fields_to_match() {
        let identity = RootIdentity {
            device_major: 1,
            device_minor: 2,
            inode: 3,
            mount_id: 4,
            mount_identity_kind: MountIdentityKind::StatxMountIdUnique,
        };
        assert_eq!(identity, identity.clone());
        assert_ne!(
            identity,
            RootIdentity {
                mount_id: 5,
                ..identity.clone()
            }
        );
    }

    #[test]
    fn mount_identity_names_are_stable() {
        assert_eq!(
            MountIdentityKind::StatxMountIdUnique.as_str(),
            "statx_mnt_id_unique"
        );
        assert_eq!(MountIdentityKind::StatxMountId.as_str(), "statx_mnt_id");
        assert_eq!(MountIdentityKind::Unavailable.as_str(), "unavailable");
    }
}
