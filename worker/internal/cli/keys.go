package cli

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/spf13/cobra"

	"github.com/ghvstcode/agentfund/worker/internal/app"
	"github.com/ghvstcode/agentfund/worker/internal/config"
	"github.com/ghvstcode/agentfund/worker/internal/lint"
	"github.com/ghvstcode/agentfund/worker/internal/lockfile"
	"github.com/ghvstcode/agentfund/worker/internal/minisign"
	"github.com/ghvstcode/agentfund/worker/internal/spec"
)

var keyNameRE = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

func keygenCmd(e *env) *cobra.Command {
	var name, out string
	var noPassword, force bool
	cmd := &cobra.Command{
		Use:   "keygen",
		Short: "Generate a maintainer signing key (minisign format)",
		Long: `Generate an Ed25519 key pair in minisign format.

The secret key is written to <out>/<name>.key with mode 0600, encrypted with a
password unless --no-password is given. The password is read from
$` + config.EnvKeyPass + ` when set, otherwise prompted for. The public key goes
into agentfund.yaml; donors compare its fingerprint before approving.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if !keyNameRE.MatchString(name) {
				return exitWith(ExitUsage, "--name must match %s", keyNameRE)
			}
			if out == "" {
				out = config.KeysDir()
			}
			secPath, pubPath := filepath.Join(out, name+".key"), filepath.Join(out, name+".pub")
			if _, err := os.Stat(secPath); err == nil && !force {
				return fmt.Errorf("%s already exists; refusing to overwrite a secret key (use --force or another --name)", secPath)
			}
			password := ""
			if !noPassword {
				password = os.Getenv(config.EnvKeyPass)
				if password == "" {
					p1, err := e.readSecret("Password for the new secret key: ")
					if err != nil {
						return fmt.Errorf("read password: %w", err)
					}
					if p1 == "" {
						return errors.New("empty password; use --no-password to write an unencrypted key")
					}
					if e.isTerminal() {
						p2, err := e.readSecret("Repeat password: ")
						if err != nil || p1 != p2 {
							return errors.New("passwords do not match")
						}
					}
					password = p1
				}
			}
			key, err := minisign.GenerateKey()
			if err != nil {
				return err
			}
			if password != "" {
				fmt.Fprintln(e.err, "Deriving the key-encryption key (scrypt, this takes a few seconds)…")
			}
			sec, err := key.Marshal(password)
			if err != nil {
				return err
			}
			if err := os.MkdirAll(out, 0o700); err != nil {
				return err
			}
			if err := os.WriteFile(secPath, sec, 0o600); err != nil {
				return err
			}
			if err := os.Chmod(secPath, 0o600); err != nil {
				return err
			}
			pk := key.Public()
			pub := fmt.Sprintf("untrusted comment: %s public key %s\n%s\n", app.BinaryName, pk.KeyIDHex(), pk.String())
			if err := os.WriteFile(pubPath, []byte(pub), 0o644); err != nil {
				return err
			}
			fmt.Fprintf(e.out, "secret key:  %s%s\npublic key:  %s\nfingerprint: %s\n\n", secPath,
				map[bool]string{true: "  (NOT password-protected)", false: ""}[password == ""], pk.String(), pk.Fingerprint())
			fmt.Fprintf(e.out, "Put this in %s:\n\n  pubkey: %s\n\nThen: %s validate tasks/ && %s sign tasks/ --key %s\n",
				app.DescriptorFile, pk.String(), app.BinaryName, app.BinaryName, secPath)
			return nil
		},
	}
	cmd.Flags().StringVar(&name, "name", "default", "key name (file stem)")
	cmd.Flags().StringVar(&out, "out", "", "directory for the key files (default: "+filepath.Join("~/.config", app.BinaryName, "keys")+")")
	cmd.Flags().BoolVar(&noPassword, "no-password", false, "write the secret key unencrypted")
	cmd.Flags().BoolVar(&force, "force", false, "overwrite an existing key of the same name")
	return cmd
}

func loadKey(e *env, path string) (minisign.PrivateKey, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return minisign.PrivateKey{}, fmt.Errorf("read secret key: %w", err)
	}
	password := ""
	if minisign.IsEncrypted(raw) {
		password = os.Getenv(config.EnvKeyPass)
		if password == "" {
			if password, err = e.readSecret("Password for " + path + ": "); err != nil {
				return minisign.PrivateKey{}, fmt.Errorf("read password: %w", err)
			}
		}
	}
	return minisign.ParsePrivateKey(raw, password)
}

func defaultKeyPath() (string, error) {
	if p := os.Getenv(config.EnvKey); p != "" {
		return p, nil
	}
	p := filepath.Join(config.KeysDir(), "default.key")
	if _, err := os.Stat(p); err == nil {
		return p, nil
	}
	found, _ := filepath.Glob(filepath.Join(config.KeysDir(), "*.key"))
	if len(found) == 1 {
		return found[0], nil
	}
	return "", fmt.Errorf("no signing key: pass --key, set %s, or run `%s keygen`", config.EnvKey, app.BinaryName)
}

func signCmd(e *env) *cobra.Command {
	var keyPath, rotateFrom string
	cmd := &cobra.Command{
		Use:   "sign <tasks-dir>",
		Short: "Write tasks/MANIFEST.lock and its minisign signature",
		Long: `Validate every manifest in <tasks-dir>, write MANIFEST.lock (the SHA-256 of
each manifest, sorted by path) and MANIFEST.lock.minisig (one prehashed
minisign signature over the lock). Existing key rotations are preserved.

--rotate-from OLDKEY appends a rotation statement signed by the old key that
authorises the new --key, then signs the lock with the new key. Remember to
put the new public key into agentfund.yaml.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			dir := args[0]
			res, err := lint.Dir(dir)
			if err != nil {
				return err
			}
			for _, f := range res.Findings {
				fmt.Fprintln(e.err, f.String())
			}
			if res.HasErrors(false) {
				return exitWith(ExitError, "refusing to sign: fix the errors above")
			}
			if keyPath == "" {
				if keyPath, err = defaultKeyPath(); err != nil {
					return err
				}
			}
			key, err := loadKey(e, keyPath)
			if err != nil {
				return err
			}
			lockPath := filepath.Join(dir, filepath.Base(lockfile.Path))
			var rotations []lockfile.Rotation
			if raw, err := os.ReadFile(lockPath); err == nil {
				old, perr := lockfile.Parse(raw)
				if perr != nil {
					return fmt.Errorf("existing %s is invalid (%v); remove it to start a fresh lock", lockPath, perr)
				}
				rotations = old.Rotations
			}
			if rotateFrom != "" {
				oldKey, err := loadKey(e, rotateFrom)
				if err != nil {
					return fmt.Errorf("--rotate-from: %w", err)
				}
				if oldKey.Public() == key.Public() {
					return errors.New("--rotate-from and --key are the same key")
				}
				link, err := lockfile.NewRotation(oldKey, key.Public())
				if err != nil {
					return err
				}
				rotations = append(rotations, link)
				fmt.Fprintf(e.out, "rotation: %s -> %s\n", oldKey.Public().Fingerprint(), key.Public().Fingerprint())
			}
			lock, err := lockfile.Build(res.Manifests, rotations)
			if err != nil {
				return err
			}
			lockBytes, sig, err := lockfile.SignLock(lock, key)
			if err != nil {
				return err
			}
			if err := os.WriteFile(lockPath, lockBytes, 0o644); err != nil {
				return err
			}
			if err := os.WriteFile(lockPath+".minisig", sig, 0o644); err != nil {
				return err
			}
			pk := key.Public()
			fmt.Fprintf(e.out, "signed %d manifest(s)\n  %s\n  %s\nkey:         %s\nfingerprint: %s\nlock sha256: %s\n",
				len(lock.Manifests), lockPath, lockPath+".minisig", pk.String(), pk.Fingerprint(), lockfile.SHA256Hex(lockBytes))
			// Channel one must publish the key that signs (or the chain must reach it).
			descPath := filepath.Join(filepath.Dir(filepath.Clean(dir)), app.DescriptorFile)
			if raw, err := os.ReadFile(descPath); err == nil {
				if d, err := spec.ParseDescriptor(raw); err == nil && d.Pubkey != pk.String() {
					fmt.Fprintf(e.err, "warning: %s publishes pubkey %s, but the lock was signed with %s — update it:\n  pubkey: %s\n",
						descPath, d.Pubkey, pk.String(), pk.String())
				}
			}
			return nil
		},
	}
	cmd.Flags().StringVar(&keyPath, "key", "", "secret key file (default: $"+config.EnvKey+" or the only key in the keys directory)")
	cmd.Flags().StringVar(&rotateFrom, "rotate-from", "", "old secret key file: append a rotation link from it to --key")
	return cmd
}

func validateCmd(e *env) *cobra.Command {
	var strict bool
	cmd := &cobra.Command{
		Use:   "validate <tasks-dir>",
		Short: "Schema-check and lint task manifests (and ../agentfund.yaml)",
		Long: `Check every manifest against the spec: strict YAML, JSON Schema, id equals
file name, depends_on exists and has no cycles; check ../agentfund.yaml when
present. Lints (warnings): write scope too broad, verify that is trivially
true, very short prompt, max_tokens above the new-project cap, missing
timeout. A write scope that addresses never-writable paths is an error.

Exit status is non-zero on errors; --strict also fails on warnings.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			res, err := lint.Dir(args[0])
			if err != nil {
				return err
			}
			errs, warns := 0, 0
			for _, f := range res.Findings {
				fmt.Fprintln(e.out, f.String())
				if f.Severity == lint.Error {
					errs++
				} else {
					warns++
				}
			}
			fmt.Fprintf(e.out, "%d manifest(s), %d error(s), %d warning(s)\n", len(res.Manifests), errs, warns)
			if res.HasErrors(strict) {
				return exitWith(ExitError, "%s", strings.TrimSpace(fmt.Sprintf("validation failed%s", map[bool]string{true: " (--strict: warnings are errors)", false: ""}[errs == 0])))
			}
			return nil
		},
	}
	cmd.Flags().BoolVar(&strict, "strict", false, "treat warnings as errors")
	return cmd
}
