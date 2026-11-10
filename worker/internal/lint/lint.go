// Package lint implements `agentfund validate`: schema checks plus the lints
// that catch manifests donors are likely (and right) to refuse.
package lint

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/ghvstcode/agentfund/worker/internal/app"
	"github.com/ghvstcode/agentfund/worker/internal/lockfile"
	"github.com/ghvstcode/agentfund/worker/internal/minisign"
	"github.com/ghvstcode/agentfund/worker/internal/spec"
)

// Severity of a finding.
type Severity string

// Severities.
const (
	Error   Severity = "error"
	Warning Severity = "warning"
)

// Finding is one problem.
type Finding struct {
	File     string
	Severity Severity
	Msg      string
}

func (f Finding) String() string { return fmt.Sprintf("%s: %s: %s", f.File, f.Severity, f.Msg) }

// Thresholds.
const (
	MinPromptChars = 80
	// NewProjectTaskCap is the default per-task cap servers apply to new projects (protocol.md §8).
	NewProjectTaskCap = 5_000_000
)

// Result of validating a tasks directory.
type Result struct {
	Findings  []Finding
	Manifests map[string][]byte // repo path -> raw bytes, for every *.yaml file
	Valid     map[string]*spec.Manifest
}

// HasErrors reports whether any finding is an error (or, with strict, any finding at all).
func (r *Result) HasErrors(strict bool) bool {
	for _, f := range r.Findings {
		if f.Severity == Error || strict {
			return true
		}
	}
	return false
}

func (r *Result) add(file string, sev Severity, format string, a ...any) {
	r.Findings = append(r.Findings, Finding{File: file, Severity: sev, Msg: fmt.Sprintf(format, a...)})
}

var trivialVerify = regexp.MustCompile(`^(true|:|exit( +0)?|/bin/true|/usr/bin/true|echo\b[^;&|]*|test +1|\[ +1 +\]|sh +-c +["']?(true|:|exit 0)["']?)$`)

// TriviallyTrue reports whether a verify command cannot fail in any useful way.
func TriviallyTrue(cmd string) bool {
	c := strings.TrimSpace(cmd)
	c = strings.TrimSuffix(c, ";")
	// "anything || true" and "anything; true" always succeed.
	for _, sep := range []string{"||", ";"} {
		if i := strings.LastIndex(c, sep); i >= 0 {
			if tail := strings.TrimSpace(c[i+len(sep):]); tail == "true" || tail == ":" || tail == "exit 0" {
				return true
			}
		}
	}
	return c == "" || trivialVerify.MatchString(strings.Join(strings.Fields(c), " "))
}

// broadGlob reports globs that hand the agent (nearly) the whole repository.
func broadGlob(g string) bool {
	switch g {
	case "**", "*", "**/*", "**/**", "*/**", "./**":
		return true
	}
	return false
}

// Dir validates <tasksDir>/*.yaml and, when present, ../agentfund.yaml.
func Dir(tasksDir string) (*Result, error) {
	res := &Result{Manifests: map[string][]byte{}, Valid: map[string]*spec.Manifest{}}
	st, err := os.Stat(tasksDir)
	if err != nil || !st.IsDir() {
		return nil, fmt.Errorf("%s is not a directory", tasksDir)
	}
	names, err := filepath.Glob(filepath.Join(tasksDir, "*.yaml"))
	if err != nil {
		return nil, err
	}
	sort.Strings(names)
	if len(names) == 0 {
		res.add(tasksDir, Error, "no manifests (*.yaml) found")
	}
	if others, _ := filepath.Glob(filepath.Join(tasksDir, "*.yml")); len(others) > 0 {
		res.add(tasksDir, Error, "%d file(s) use the .yml extension; manifests must be named <id>.yaml", len(others))
	}
	deps := map[string][]string{}
	for _, n := range names {
		rel := "tasks/" + filepath.Base(n)
		raw, err := os.ReadFile(n)
		if err != nil {
			return nil, err
		}
		res.Manifests[rel] = raw
		m, err := spec.ParseManifestAt(rel, raw)
		if err != nil {
			res.add(rel, Error, "%v", err)
			continue
		}
		res.Valid[rel] = m
		deps[m.ID] = m.DependsOn
		lintManifest(res, rel, m)
	}
	if len(res.Valid) == len(names) {
		if err := lockfile.CheckDependencies(deps); err != nil {
			res.add(tasksDir, Error, "%v", err)
		}
	} else {
		// Still report unknown dependencies among the manifests that did parse.
		for rel, m := range res.Valid {
			for _, d := range m.DependsOn {
				if _, ok := deps[d]; !ok {
					if _, exists := res.Manifests[spec.ManifestPath(d)]; !exists {
						res.add(rel, Error, "depends_on unknown task %q", d)
					}
				}
			}
		}
	}

	descPath := filepath.Join(filepath.Dir(filepath.Clean(tasksDir)), app.DescriptorFile)
	if raw, err := os.ReadFile(descPath); err == nil {
		d, err := spec.ParseDescriptor(raw)
		if err != nil {
			res.add(app.DescriptorFile, Error, "%v", err)
		} else {
			if _, err := minisign.ParsePublicKey(d.Pubkey); err != nil {
				res.add(app.DescriptorFile, Error, "pubkey: %v", err)
			}
			var total int64
			for _, m := range res.Valid {
				total += m.MaxTokens
			}
			if d.TokenGoal > 0 && len(res.Valid) == len(names) && d.TokenGoal < total {
				res.add(app.DescriptorFile, Warning, "token_goal %d is below the sum of max_tokens (%d)", d.TokenGoal, total)
			}
		}
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	sort.SliceStable(res.Findings, func(i, j int) bool { return res.Findings[i].File < res.Findings[j].File })
	return res, nil
}

func lintManifest(res *Result, rel string, m *spec.Manifest) {
	for _, g := range m.Scope.Write {
		if broadGlob(g) {
			res.add(rel, Warning, "scope.write %q is too broad: it lets the agent change the whole repository; name the directories or files the task needs", g)
		}
		if spec.NeverWritable(g) || strings.HasPrefix(g, "tasks/") || strings.HasPrefix(g, ".github/") || g == "agentfund.yaml" || g == ".github" || g == "tasks" {
			res.add(rel, Error, "scope.write %q addresses a never-writable path (agentfund.yaml, tasks/**, .github/** can never be changed by a task)", g)
		}
	}
	if TriviallyTrue(m.Verify) {
		res.add(rel, Warning, "verify %q is trivially true: it cannot tell a good run from a bad one", m.Verify)
	}
	if n := len([]rune(strings.TrimSpace(m.Prompt))); n < MinPromptChars {
		res.add(rel, Warning, "prompt is only %d characters; an agent needs a self-contained instruction (aim for at least %d)", n, MinPromptChars)
	}
	if m.MaxTokens > NewProjectTaskCap {
		res.add(rel, Warning, "max_tokens %d is above %d, the default per-task cap for new projects: servers will refuse claims until the project is established", m.MaxTokens, NewProjectTaskCap)
	}
	if !m.TimeoutSet {
		res.add(rel, Warning, "timeout_minutes is not set (defaults to %d)", spec.DefaultTimeoutMinutes)
	}
	for _, d := range m.DependsOn {
		if d == m.ID {
			res.add(rel, Error, "task depends on itself")
		}
	}
}
