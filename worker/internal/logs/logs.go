// Package logs writes the local, append-only run log: one JSON object per
// line holding the full prompt, the manifest, every agent stream event, the
// verify output, the diff, egress proxy decisions and the outcome. The
// digest reported to the server is the SHA-256 of that file.
//
// Secrets (the donor's agent credentials) are scrubbed from every line before
// it is written.
package logs

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// Redacted replaces every secret occurrence.
const Redacted = "[REDACTED]"

// Scrubber removes secret values from text.
type Scrubber struct{ r *strings.Replacer }

// NewScrubber builds a scrubber for the given secret values. Both the raw
// value and its JSON-escaped form are replaced.
func NewScrubber(secrets []string) *Scrubber {
	var pairs []string
	seen := map[string]bool{}
	sorted := append([]string{}, secrets...)
	sort.Slice(sorted, func(i, j int) bool { return len(sorted[i]) > len(sorted[j]) })
	for _, s := range sorted {
		if len(s) < 8 || seen[s] {
			continue
		}
		seen[s] = true
		pairs = append(pairs, s, Redacted)
		if esc, err := json.Marshal(s); err == nil {
			if inner := string(esc[1 : len(esc)-1]); inner != s {
				pairs = append(pairs, inner, Redacted)
			}
		}
	}
	return &Scrubber{r: strings.NewReplacer(pairs...)}
}

// String scrubs s.
func (s *Scrubber) String(in string) string {
	if s == nil || s.r == nil {
		return in
	}
	return s.r.Replace(in)
}

// Run is one claim's log file.
type Run struct {
	mu     sync.Mutex
	f      *os.File
	path   string
	scrub  *Scrubber
	frozen bool
}

var claimRE = regexp.MustCompile(`^[A-Za-z0-9_-]{1,80}$`)

// Open creates <dir>/<YYYY-MM-DD>/<claim>.log (0600).
func Open(dir, claim string, now time.Time, scrub *Scrubber) (*Run, error) {
	if !claimRE.MatchString(claim) {
		return nil, fmt.Errorf("logs: unusable claim id %q", claim)
	}
	day := filepath.Join(dir, now.Format("2006-01-02"))
	if err := os.MkdirAll(day, 0o700); err != nil {
		return nil, err
	}
	p := filepath.Join(day, claim+".log")
	f, err := os.OpenFile(p, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return nil, err
	}
	return &Run{f: f, path: p, scrub: scrub}, nil
}

// Path returns the log file path.
func (r *Run) Path() string { return r.path }

// Scrub exposes the run's scrubber.
func (r *Run) Scrub(s string) string { return r.scrub.String(s) }

// Event appends {"ts":…,"kind":kind,…fields}.
func (r *Run) Event(kind string, fields map[string]any) {
	rec := map[string]any{"ts": time.Now().UTC().Format(time.RFC3339Nano), "kind": kind}
	for k, v := range fields {
		if k != "ts" && k != "kind" {
			rec[k] = v
		}
	}
	b, err := json.Marshal(rec)
	if err != nil {
		b, _ = json.Marshal(map[string]any{"ts": rec["ts"], "kind": kind, "error": "unencodable event: " + err.Error()})
	}
	r.write(b)
}

// Raw appends a line produced by another program (agent stream event, proxy
// log line). Valid JSON is embedded as-is under "event"; anything else as a string.
func (r *Run) Raw(kind string, line []byte) {
	var ev any = string(line)
	if json.Valid(line) {
		ev = json.RawMessage(append([]byte{}, line...))
	}
	r.Event(kind, map[string]any{"event": ev})
}

func (r *Run) write(line []byte) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.frozen || r.f == nil {
		return
	}
	out := r.scrub.String(string(line))
	_, _ = r.f.WriteString(out + "\n")
}

// Freeze stops further writes and returns the SHA-256 of the file as it
// stands. Everything that happens afterwards belongs in the report sidecar.
func (r *Run) Freeze() (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.frozen = true
	if r.f != nil {
		if err := r.f.Sync(); err != nil {
			return "", err
		}
	}
	return DigestFile(r.path)
}

// DigestFile returns the lowercase hex SHA-256 of a file.
func DigestFile(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// SidecarPath returns the path of the report sidecar for a log file.
func SidecarPath(logPath string) string {
	return strings.TrimSuffix(logPath, ".log") + ".report.json"
}

// WriteSidecar stores what happened after the log was frozen: the digest, the
// report sent and the server's answer. It is scrubbed like the log.
func (r *Run) WriteSidecar(v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(SidecarPath(r.path), []byte(r.scrub.String(string(b))+"\n"), 0o600)
}

// Close closes the file.
func (r *Run) Close() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.f != nil {
		_ = r.f.Close()
		r.f = nil
	}
}

// Entry is one log file on disk.
type Entry struct {
	Claim string
	Path  string
	Day   string
	Mod   time.Time
}

// List returns all run logs under dir, newest first.
func List(dir string) ([]Entry, error) {
	var out []Entry
	days, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	for _, d := range days {
		if !d.IsDir() {
			continue
		}
		files, _ := os.ReadDir(filepath.Join(dir, d.Name()))
		for _, f := range files {
			if !strings.HasSuffix(f.Name(), ".log") {
				continue
			}
			info, err := f.Info()
			if err != nil {
				continue
			}
			out = append(out, Entry{Claim: strings.TrimSuffix(f.Name(), ".log"), Path: filepath.Join(dir, d.Name(), f.Name()), Day: d.Name(), Mod: info.ModTime()})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Mod.After(out[j].Mod) })
	return out, nil
}

// Find locates the log of a claim (exact id or unique prefix/suffix).
func Find(dir, claim string) (Entry, error) {
	all, err := List(dir)
	if err != nil {
		return Entry{}, err
	}
	var matches []Entry
	for _, e := range all {
		if e.Claim == claim {
			return e, nil
		}
		if strings.Contains(e.Claim, claim) {
			matches = append(matches, e)
		}
	}
	switch len(matches) {
	case 0:
		return Entry{}, fmt.Errorf("no log for claim %q under %s", claim, dir)
	case 1:
		return matches[0], nil
	}
	return Entry{}, fmt.Errorf("claim %q matches %d logs; be more specific", claim, len(matches))
}

// Tail keeps the last n bytes written to it (for bounded capture of command output).
type Tail struct {
	mu    sync.Mutex
	buf   bytes.Buffer
	limit int
	lost  int64
}

// NewTail returns a writer retaining at most limit bytes.
func NewTail(limit int) *Tail { return &Tail{limit: limit} }

func (t *Tail) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.buf.Write(p)
	if over := t.buf.Len() - t.limit; over > 0 {
		t.lost += int64(over)
		t.buf.Next(over)
	}
	return len(p), nil
}

// String returns the retained output, noting truncation.
func (t *Tail) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.lost > 0 {
		return fmt.Sprintf("[… %d earlier bytes dropped …]\n%s", t.lost, t.buf.String())
	}
	return t.buf.String()
}
