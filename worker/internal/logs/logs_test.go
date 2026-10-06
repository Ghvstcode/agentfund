package logs

import (
	"bufio"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"
)

func TestScrubAndDigest(t *testing.T) {
	const secret = `sk-ant-oat01-"quoted\secret"-0123456789`
	const plain = "sk-ant-api03-PLAINSECRET000"
	dir := t.TempDir()
	r, err := Open(dir, "clm_0000000000000001", time.Now(), NewScrubber([]string{secret, plain, "short"}))
	if err != nil {
		t.Fatal(err)
	}
	r.Event("start", map[string]any{"prompt": "do it", "leak": "token=" + plain, "nested": map[string]any{"deep": []string{secret}}})
	r.Raw("agent", []byte(`{"type":"assistant","text":"my key is `+plain+`"}`))
	r.Raw("agent", []byte("not json "+plain))
	r.Raw("agent", []byte(`{"env":"`+strings.ReplaceAll(strings.ReplaceAll(secret, `\`, `\\`), `"`, `\"`)+`"}`))
	digest, err := r.Freeze()
	if err != nil || len(digest) != 64 {
		t.Fatalf("freeze: %q %v", digest, err)
	}
	r.Event("late", map[string]any{"x": 1}) // must not change the file
	if again, _ := DigestFile(r.Path()); again != digest {
		t.Fatal("log changed after Freeze")
	}
	if err := r.WriteSidecar(map[string]any{"log_digest": digest, "message": "failed with " + plain}); err != nil {
		t.Fatal(err)
	}
	r.Close()

	raw, _ := os.ReadFile(r.Path())
	side, _ := os.ReadFile(SidecarPath(r.Path()))
	for _, blob := range [][]byte{raw, side} {
		if strings.Contains(string(blob), plain) || strings.Contains(string(blob), "quoted") {
			t.Fatalf("secret leaked:\n%s", blob)
		}
		if !strings.Contains(string(blob), Redacted) {
			t.Fatalf("expected redaction marker in:\n%s", blob)
		}
	}
	// Every line is still valid JSON with ts and kind.
	sc := bufio.NewScanner(strings.NewReader(string(raw)))
	n := 0
	for sc.Scan() {
		var rec map[string]any
		if err := json.Unmarshal(sc.Bytes(), &rec); err != nil || rec["ts"] == nil || rec["kind"] == nil {
			t.Fatalf("bad line %q: %v", sc.Text(), err)
		}
		n++
	}
	if n != 4 {
		t.Fatalf("%d lines, want 4", n)
	}
	if st, _ := os.Stat(r.Path()); st.Mode().Perm() != 0o600 {
		t.Fatalf("log mode %v", st.Mode().Perm())
	}
	if e, err := Find(dir, "clm_0000000000000001"); err != nil || e.Path != r.Path() {
		t.Fatalf("find: %+v %v", e, err)
	}
	if e, err := Find(dir, "00000001"); err != nil || e.Path != r.Path() {
		t.Fatalf("find by fragment: %+v %v", e, err)
	}
	if _, err := Find(dir, "nope"); err == nil {
		t.Fatal("found a missing claim")
	}
	if _, err := Open(dir, "../escape", time.Now(), nil); err == nil {
		t.Fatal("path traversal in claim id accepted")
	}
}

func TestTail(t *testing.T) {
	tl := NewTail(10)
	tl.Write([]byte("0123456789"))
	if tl.String() != "0123456789" {
		t.Fatal(tl.String())
	}
	tl.Write([]byte("abcde"))
	if s := tl.String(); !strings.HasSuffix(s, "56789abcde") || !strings.Contains(s, "5 earlier bytes dropped") {
		t.Fatal(s)
	}
}
