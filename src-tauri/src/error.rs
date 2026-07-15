use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid input: {0}")]
    InvalidInput(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("unsupported operation: {0}")]
    Unsupported(String),
    #[error("internal error: {0}")]
    Internal(String),
    #[error("AI descriptions are not configured: {0}")]
    AiNotConfigured(String),
    #[error("AI provider authentication failed")]
    AiAuth,
    #[error("AI provider is offline: {0}")]
    AiOffline(String),
    #[error("AI provider request timed out")]
    AiTimeout,
    #[error("AI provider rate limit reached")]
    AiRateLimit,
    #[error("AI provider returned an invalid response: {0}")]
    AiResponseInvalid(String),
    #[error("the remote AI input contains sensitive material")]
    AiSensitiveInput,
    #[error("sending a SKILL.md excerpt to a remote provider requires confirmation")]
    AiBodyConfirmRequired,
    #[error("sending Skill text to a remote provider requires a source-bound confirmation")]
    AiRemoteConfirmRequired,
    #[error("the Skill source changed while its description was being generated")]
    SourceChanged,
    #[error("an AI description batch is already running")]
    AiAlreadyRunning,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorPayload {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let (code, retryable) = (self.code(), self.retryable());
        ErrorPayload {
            code: code.to_owned(),
            message: self.to_string(),
            retryable,
        }
        .serialize(serializer)
    }
}

impl AppError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Database(_) => "DATABASE_ERROR",
            Self::Io(_) => "IO_ERROR",
            Self::InvalidInput(_) => "INVALID_INPUT",
            Self::NotFound(_) => "NOT_FOUND",
            Self::Conflict(_) => "CONFLICT",
            Self::Unsupported(_) => "UNSUPPORTED",
            Self::Internal(_) => "INTERNAL_ERROR",
            Self::AiNotConfigured(_) => "AI_NOT_CONFIGURED",
            Self::AiAuth => "AI_AUTH_ERROR",
            Self::AiOffline(_) => "AI_OFFLINE",
            Self::AiTimeout => "AI_TIMEOUT",
            Self::AiRateLimit => "AI_RATE_LIMIT",
            Self::AiResponseInvalid(_) => "AI_RESPONSE_INVALID",
            Self::AiSensitiveInput => "AI_SENSITIVE_INPUT",
            Self::AiBodyConfirmRequired => "AI_BODY_CONFIRM_REQUIRED",
            Self::AiRemoteConfirmRequired => "AI_REMOTE_CONFIRM_REQUIRED",
            Self::SourceChanged => "SOURCE_CHANGED",
            Self::AiAlreadyRunning => "AI_ALREADY_RUNNING",
        }
    }

    pub fn retryable(&self) -> bool {
        matches!(
            self,
            Self::Database(_)
                | Self::Io(_)
                | Self::Conflict(_)
                | Self::AiOffline(_)
                | Self::AiTimeout
                | Self::AiRateLimit
                | Self::SourceChanged
        )
    }
}

pub type AppResult<T> = Result<T, AppError>;
