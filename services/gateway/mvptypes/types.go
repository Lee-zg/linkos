package mvptypes

type Permission string

type ResourceGrant struct {
	Subject string   `json:"subject"`
	Actions []string `json:"actions"`
}

type ResourceACL struct {
	OwnerID string          `json:"ownerId,omitempty"`
	Grants  []ResourceGrant `json:"grants"`
}

type ResourceRecord struct {
	ID             string                 `json:"id"`
	WorkspaceID    string                 `json:"workspaceId"`
	Type           string                 `json:"type"`
	Name           string                 `json:"name"`
	ParentID       string                 `json:"parentId,omitempty"`
	OwnerID        string                 `json:"ownerId,omitempty"`
	ACL            ResourceACL            `json:"acl,omitempty"`
	Meta           map[string]interface{} `json:"meta,omitempty"`
	CreatedAt      string                 `json:"createdAt"`
	UpdatedAt      string                 `json:"updatedAt"`
	LastAccessedAt string                 `json:"lastAccessedAt,omitempty"`
}

type ResourceShareLink struct {
	Token      string `json:"token"`
	ResourceID string `json:"resourceId"`
	ExpiresAt  string `json:"expiresAt"`
	SingleUse  bool   `json:"singleUse"`
	CreatedBy  string `json:"createdBy"`
	CreatedAt  string `json:"createdAt"`
	UsedAt     string `json:"usedAt,omitempty"`
	RevokedAt  string `json:"revokedAt,omitempty"`
}

type ChatChannel struct {
	ID          string   `json:"id"`
	WorkspaceID string   `json:"workspaceId"`
	Name        string   `json:"name"`
	Kind        string   `json:"kind"`
	MemberIDs   []string `json:"memberIds"`
	CreatedAt   string   `json:"createdAt"`
}

type MessageBlock struct {
	Type  string                 `json:"type"`
	Value map[string]interface{} `json:"value"`
}

type MessageCreateInput struct {
	Body        string         `json:"body"`
	ChannelID   string         `json:"channelId"`
	ClientMsgID string         `json:"clientMsgId"`
	ThreadID    string         `json:"threadId,omitempty"`
	Mentions    []string       `json:"mentions,omitempty"`
	Blocks      []MessageBlock `json:"blocks,omitempty"`
}

type ChatMessage struct {
	ID          string         `json:"id"`
	ChannelID   string         `json:"channelId"`
	ThreadID    string         `json:"threadId,omitempty"`
	AuthorID    string         `json:"authorId"`
	AuthorName  string         `json:"authorName"`
	Body        string         `json:"body"`
	Blocks      []MessageBlock `json:"blocks,omitempty"`
	Mentions    []string       `json:"mentions,omitempty"`
	ClientMsgID string         `json:"clientMsgId,omitempty"`
	CreatedAt   string         `json:"createdAt"`
	EditedAt    string         `json:"editedAt,omitempty"`
	DeletedAt   string         `json:"deletedAt,omitempty"`
	Version     int            `json:"version"`
}

type AcceptedMessage struct {
	MessageID   string `json:"messageId"`
	Status      string `json:"status"`
	ServerMsgID string `json:"serverMsgId,omitempty"`
	Seq         int64  `json:"seq,omitempty"`
}

type JobStatus string
type JobRef struct {
	ID        string    `json:"id"`
	Status    JobStatus `json:"status"`
	RunnerID  string    `json:"runnerId,omitempty"`
	CreatedAt string    `json:"createdAt,omitempty"`
	StartedAt string    `json:"startedAt,omitempty"`
	EndedAt   string    `json:"endedAt,omitempty"`
}

type JobSpec struct {
	ProjectID      string            `json:"projectId"`
	Command        string            `json:"command"`
	BaseVersion    string            `json:"baseVersion,omitempty"`
	TimeoutSeconds int               `json:"timeoutSeconds"`
	MemoryMb       int               `json:"memoryMb"`
	Network        string            `json:"network"`
	Priority       string            `json:"priority,omitempty"`
	Env            map[string]string `json:"env,omitempty"`
	ArtifactGlobs  []string          `json:"artifactGlobs,omitempty"`
}

type JobLogChunk struct {
	JobID string `json:"jobId"`
	Seq   int    `json:"seq"`
	Level string `json:"level"`
	Chunk string `json:"chunk"`
	At    string `json:"at"`
}

type JobArtifact struct {
	ID          string `json:"id"`
	JobID       string `json:"jobId"`
	Name        string `json:"name"`
	ResourceID  string `json:"resourceId,omitempty"`
	Size        int64  `json:"size"`
	ContentHash string `json:"contentHash,omitempty"`
	CreatedAt   string `json:"createdAt"`
}

type RunnerInfo struct {
	ID                string            `json:"id"`
	WorkspaceID       string            `json:"workspaceId"`
	Platform          string            `json:"platform"`
	Version           string            `json:"version"`
	Capabilities      []string          `json:"capabilities"`
	Labels            map[string]string `json:"labels"`
	Status            string            `json:"status"`
	LastSeenAt        string            `json:"lastSeenAt"`
	CredentialVersion int               `json:"credentialVersion,omitempty"`
	RevokedAt         string            `json:"revokedAt,omitempty"`
}

type PluginRunnerConfig struct {
	Required bool `json:"required"`
}

type PluginManifest struct {
	ID          string                 `json:"id"`
	Name        string                 `json:"name"`
	Version     string                 `json:"version"`
	APIVersion  string                 `json:"apiVersion"`
	Entry       map[string]string      `json:"entry"`
	Permissions []string               `json:"permissions"`
	Contributes map[string][]string    `json:"contributes"`
	Network     map[string]interface{} `json:"network,omitempty"`
	Runner      *PluginRunnerConfig    `json:"runner,omitempty"`
}

type PluginRecord struct {
	ID          string          `json:"id"`
	Name        string          `json:"name"`
	Version     string          `json:"version"`
	APIVersion  string          `json:"apiVersion"`
	Status      string          `json:"status"`
	Manifest    PluginManifest  `json:"manifest"`
	Signature   string          `json:"signature,omitempty"`
	Permissions []string        `json:"permissions"`
	InstalledAt string          `json:"installedAt,omitempty"`
	Health      string          `json:"health,omitempty"`
	Previous    *PluginPrevious `json:"previous,omitempty"`
}

type PluginPrevious struct {
	Manifest  PluginManifest `json:"manifest"`
	Signature string         `json:"signature,omitempty"`
	Status    string         `json:"status"`
}

type CodeFile struct {
	ID          string `json:"id"`
	ProjectID   string `json:"projectId"`
	Path        string `json:"path"`
	Language    string `json:"language"`
	Size        int64  `json:"size"`
	ContentHash string `json:"contentHash"`
	Version     string `json:"version"`
	UpdatedAt   string `json:"updatedAt"`
}

type CodeVersion struct {
	ID          string         `json:"id"`
	FileID      string         `json:"fileId"`
	Version     string         `json:"version"`
	ContentHash string         `json:"contentHash"`
	Content     string         `json:"content"`
	CreatedBy   string         `json:"createdBy"`
	CreatedAt   string         `json:"createdAt"`
	DiffSummary map[string]int `json:"diffSummary,omitempty"`
}

type CodeConflict struct {
	Error       string      `json:"error"`
	Current     CodeVersion `json:"current"`
	BaseVersion string      `json:"baseVersion"`
	Diff        string      `json:"diff"`
}

type CodeSaveInput struct {
	Content     string `json:"content"`
	BaseVersion string `json:"baseVersion"`
	Message     string `json:"message,omitempty"`
}

type PluginStatus string
