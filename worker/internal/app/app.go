// Package app holds the product identity in one place so the project can be
// renamed without touching the rest of the code base.
package app

const (
	// AppName is the human-readable product name.
	AppName = "AgentFund"
	// BinaryName is the name of the CLI binary and the prefix of config dirs.
	BinaryName = "agentfund"
	// EnvPrefix prefixes every environment variable the worker reads.
	EnvPrefix = "AGENTFUND"
	// LabelPrefix prefixes docker labels and resource names.
	LabelPrefix = "agentfund"
	// BranchPrefix is mandated by the wire protocol (protocol.md §5).
	BranchPrefix = "agentfund/"
	// TrailerPrefix prefixes commit trailers.
	TrailerPrefix = "AgentFund"
	// RotationHeader is the first line of a key rotation statement (manifest.md §3).
	RotationHeader = "agentfund-key-rotation-v1"
	// DescriptorFile is the project descriptor at the repo root.
	DescriptorFile = "agentfund.yaml"
	// DefaultReleaseRepo is the placeholder GitHub repo releases are published to.
	DefaultReleaseRepo = "agentfund/agentfund"
)

// Version, Commit and Date are stamped by the linker (see .goreleaser.yaml).
var (
	Version = "dev"
	Commit  = "none"
	Date    = "unknown"
)

// UserAgent identifies the worker on the wire.
func UserAgent() string { return BinaryName + "-worker/" + Version }
