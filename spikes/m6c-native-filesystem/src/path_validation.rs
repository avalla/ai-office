use crate::SpikeError;

pub const RESERVED_TRANSACTION_PREFIX: &str = ".ai-office-txn-";

#[derive(Clone, Copy, Debug)]
pub struct PathLimits {
    pub max_bytes: usize,
    pub max_segments: usize,
}

impl Default for PathLimits {
    fn default() -> Self {
        Self {
            max_bytes: 1_024,
            max_segments: 128,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ValidatedPath {
    normalized: String,
    parent: String,
    basename: String,
}

impl ValidatedPath {
    pub fn as_str(&self) -> &str {
        &self.normalized
    }

    pub fn parent(&self) -> &str {
        &self.parent
    }

    pub fn basename(&self) -> &str {
        &self.basename
    }
}

pub fn validate_public_path(input: &str, limits: PathLimits) -> Result<ValidatedPath, SpikeError> {
    if input.is_empty() {
        return Err(SpikeError::InvalidPath("path is empty"));
    }
    if input.as_bytes().contains(&0) {
        return Err(SpikeError::InvalidPath("path contains NUL"));
    }
    if input.starts_with('/') || input.starts_with('\\') {
        return Err(SpikeError::InvalidPath("path is absolute"));
    }
    if input.contains('\\') {
        return Err(SpikeError::InvalidPath("backslash is not portable"));
    }
    if input.len() > limits.max_bytes {
        return Err(SpikeError::InvalidPath("path exceeds byte limit"));
    }

    let segments: Vec<&str> = input.split('/').collect();
    if segments.len() > limits.max_segments {
        return Err(SpikeError::InvalidPath("path exceeds segment limit"));
    }
    for segment in &segments {
        if segment.is_empty() {
            return Err(SpikeError::InvalidPath("path contains an empty component"));
        }
        if *segment == "." || *segment == ".." {
            return Err(SpikeError::InvalidPath("dot components are denied"));
        }
        if segment
            .to_ascii_lowercase()
            .starts_with(RESERVED_TRANSACTION_PREFIX)
        {
            return Err(SpikeError::InvalidPath(
                "reserved transaction namespace is denied",
            ));
        }
    }

    let basename = segments
        .last()
        .ok_or(SpikeError::InvalidPath("final basename is missing"))?;
    if basename.is_empty() || *basename == "." || *basename == ".." {
        return Err(SpikeError::InvalidPath("final basename is invalid"));
    }
    let parent = if segments.len() == 1 {
        String::new()
    } else {
        segments[..segments.len() - 1].join("/")
    };

    Ok(ValidatedPath {
        normalized: input.to_owned(),
        parent,
        basename: (*basename).to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_canonical_relative_path() {
        let value = validate_public_path("src/app.ts", PathLimits::default()).unwrap();
        assert_eq!(value.parent(), "src");
        assert_eq!(value.basename(), "app.ts");
    }

    #[test]
    fn rejects_security_sensitive_forms() {
        for path in [
            "/etc/passwd",
            "../secret",
            "a/./b",
            "a//b",
            "a/",
            "a\\b",
            ".ai-office-txn-owned",
            "a/.AI-OFFICE-TXN-owned/file",
        ] {
            assert!(
                validate_public_path(path, PathLimits::default()).is_err(),
                "{path}"
            );
        }
        assert!(validate_public_path("nul\0byte", PathLimits::default()).is_err());
    }

    #[test]
    fn enforces_limits_independently() {
        assert!(validate_public_path(
            "abcdef",
            PathLimits {
                max_bytes: 5,
                max_segments: 10,
            },
        )
        .is_err());
        assert!(validate_public_path(
            "a/b/c",
            PathLimits {
                max_bytes: 100,
                max_segments: 2,
            },
        )
        .is_err());
    }
}
