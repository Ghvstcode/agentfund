package spec

import (
	"fmt"
	"path"
	"regexp"
	"strings"

	"github.com/bmatcuk/doublestar/v4"
)

// Scope is the manifest's file scope.
type Scope struct {
	Write []string `json:"write"`
	Read  []string `json:"read,omitempty"`
}

// Manifest is one task manifest (tasks/<id>.yaml), spec_version 1.
type Manifest struct {
	SpecVersion    int      `json:"spec_version"`
	ID             string   `json:"id"`
	Title          string   `json:"title"`
	Prompt         string   `json:"prompt"`
	Scope          Scope    `json:"scope"`
	Verify         string   `json:"verify"`
	MaxTokens      int64    `json:"max_tokens"`
	TimeoutMinutes int      `json:"timeout_minutes,omitempty"`
	DependsOn      []string `json:"depends_on,omitempty"`
	BaseBranch     string   `json:"base_branch,omitempty"`

	// TimeoutSet records whether timeout_minutes was present (for linting).
	TimeoutSet bool `json:"-"`
	// ReadSet records whether scope.read was present (an empty list is not "whole repo").
	ReadSet bool `json:"-"`
}

// Defaults from the manifest schema.
const (
	DefaultTimeoutMinutes = 60
	DefaultBaseBranch     = "main"
)

// Descriptor is agentfund.yaml.
type Descriptor struct {
	SpecVersion int      `json:"spec_version"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	RepoURL     string   `json:"repo_url"`
	CIProvider  string   `json:"ci_provider"`
	Pubkey      string   `json:"pubkey"`
	BaseBranch  string   `json:"base_branch,omitempty"`
	Homepage    string   `json:"homepage,omitempty"`
	Language    string   `json:"language,omitempty"`
	Tags        []string `json:"tags,omitempty"`
	TokenGoal   int64    `json:"token_goal,omitempty"`
}

var manifestPathRE = regexp.MustCompile(`^tasks/([0-9]{4}-[a-z0-9]+(?:-[a-z0-9]+)*)\.yaml$`)

// IDFromPath returns the manifest id a repo path must carry, or false when
// the path is not a valid manifest path.
func IDFromPath(p string) (string, bool) {
	m := manifestPathRE.FindStringSubmatch(p)
	if m == nil {
		return "", false
	}
	return m[1], true
}

// ManifestPath returns tasks/<id>.yaml.
func ManifestPath(id string) string { return "tasks/" + id + ".yaml" }

// ParseManifest strictly parses and schema-validates raw manifest bytes and
// applies schema defaults. It does not check the id against a file name.
func ParseManifest(raw []byte) (*Manifest, error) {
	doc, err := ParseYAML(raw)
	if err != nil {
		return nil, err
	}
	if m, ok := doc.(map[string]any); ok {
		if v, present := m["spec_version"]; present && fmt.Sprint(v) != fmt.Sprint(SpecVersion) {
			return nil, fmt.Errorf("unsupported spec_version %v (this worker understands %d)", v, SpecVersion)
		}
	}
	if err := Validate(SchemaManifest, doc); err != nil {
		return nil, err
	}
	var m Manifest
	if err := decodeInto(doc, &m); err != nil {
		return nil, fmt.Errorf("manifest: %w", err)
	}
	top := doc.(map[string]any)
	_, m.TimeoutSet = top["timeout_minutes"]
	if sc, ok := top["scope"].(map[string]any); ok {
		_, m.ReadSet = sc["read"]
	}
	if m.TimeoutMinutes == 0 {
		m.TimeoutMinutes = DefaultTimeoutMinutes
	}
	if m.BaseBranch == "" {
		m.BaseBranch = DefaultBaseBranch
	}
	for _, g := range append(append([]string{}, m.Scope.Write...), m.Scope.Read...) {
		if !doublestar.ValidatePattern(g) {
			return nil, fmt.Errorf("manifest: invalid glob %q", g)
		}
	}
	return &m, nil
}

// ParseManifestAt is ParseManifest plus the check that id equals the file stem.
func ParseManifestAt(repoPath string, raw []byte) (*Manifest, error) {
	want, ok := IDFromPath(repoPath)
	if !ok {
		return nil, fmt.Errorf("%s is not a valid manifest path (want tasks/NNNN-slug.yaml)", repoPath)
	}
	m, err := ParseManifest(raw)
	if err != nil {
		return nil, err
	}
	if m.ID != want {
		return nil, fmt.Errorf("manifest id %q does not match file name %q", m.ID, path.Base(repoPath))
	}
	return m, nil
}

// ParseDescriptor strictly parses and schema-validates agentfund.yaml.
func ParseDescriptor(raw []byte) (*Descriptor, error) {
	doc, err := ParseYAML(raw)
	if err != nil {
		return nil, err
	}
	if err := Validate(SchemaDescriptor, doc); err != nil {
		return nil, err
	}
	var d Descriptor
	if err := decodeInto(doc, &d); err != nil {
		return nil, fmt.Errorf("descriptor: %w", err)
	}
	if d.BaseBranch == "" {
		d.BaseBranch = DefaultBaseBranch
	}
	return &d, nil
}

// neverWritable are the paths no task may change regardless of its globs.
var neverWritable = []string{"agentfund.yaml", "tasks/**", ".github/**"}

// NeverWritable reports whether a clean repo-relative path is never writable
// (manifest.md §1): agentfund.yaml, tasks/**, .github/** — plus .git/.
func NeverWritable(p string) bool {
	if p == ".git" || strings.HasPrefix(p, ".git/") || p == "tasks" || p == ".github" {
		return true
	}
	return MatchAny(neverWritable, p)
}

// MatchAny reports whether the repo-relative path matches any glob
// (doublestar semantics, case-sensitive).
func MatchAny(globs []string, p string) bool {
	for _, g := range globs {
		if ok, err := doublestar.Match(g, p); err == nil && ok {
			return true
		}
	}
	return false
}

// Writable reports whether path p may be changed by a task with these write globs.
func Writable(write []string, p string) bool {
	return !NeverWritable(p) && MatchAny(write, p)
}

// LiteralPrefixDir returns the directory formed by the leading path segments
// of a glob that contain no glob metacharacters, excluding the final segment
// (which names a file or pattern), and whether the glob has any wildcard.
// "src/**" -> ("src", true); "src/a.py" -> ("src", false); "*.md" -> ("", true).
func LiteralPrefixDir(glob string) (dir string, wild bool) {
	segs := strings.Split(glob, "/")
	var lit []string
	for i, s := range segs {
		if strings.ContainsAny(s, "*?[{\\") {
			wild = true
			break
		}
		if i == len(segs)-1 {
			break
		}
		lit = append(lit, s)
	}
	return strings.Join(lit, "/"), wild
}
