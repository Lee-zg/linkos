package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

type userCLIInstall struct {
	Owner          string `json:"owner"`
	Binary         string `json:"binary"`
	Launcher       string `json:"launcher"`
	LauncherSHA256 string `json:"launcherSHA256"`
}

func defaultCLIInstallDir() string {
	if runtime.GOOS == "windows" {
		base := os.Getenv("LOCALAPPDATA")
		if base != "" {
			return filepath.Join(base, "Programs", "LinkOS")
		}
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".local", "share", "linkos-cli")
}
func installUserCLI(o projectOptions, requested string) error {
	binary, err := os.Executable()
	if err != nil {
		return err
	}
	if bundledAssets == nil {
		o.Command = "pack"
		o.Action = ""
		o.Config.Pack.Targets = []string{runtime.GOOS + "/" + runtime.GOARCH}
		if err = runProjectAdapter(o); err != nil {
			return err
		}
		name := "linkos"
		if runtime.GOOS == "windows" {
			name += ".exe"
		}
		binary = filepath.Join(o.Config.Pack.OutDir, "linkos-"+o.Version+"-"+runtime.GOOS+"-"+runtime.GOARCH, name)
	}
	raw, err := os.ReadFile(binary)
	if err != nil {
		return err
	}
	digest := sha256.Sum256(raw)
	identity := hex.EncodeToString(digest[:])[:20]
	root := requested
	if root == "" {
		root = defaultCLIInstallDir()
	}
	root, err = filepath.Abs(root)
	if err != nil {
		return err
	}
	installLock, err := acquireDataLock(root + ".install")
	if err != nil {
		return fmt.Errorf("CLI installation is in use: %w", err)
	}
	defer installLock.Close()
	marker := filepath.Join(root, "install.json")
	var previous userCLIInstall
	if data, e := os.ReadFile(marker); e == nil {
		if json.Unmarshal(data, &previous) != nil || previous.Owner != "linkos-cli/1" {
			return errors.New("installation directory has an unrelated owner")
		}
	} else if !os.IsNotExist(e) {
		return e
	} else if entries, e := os.ReadDir(root); e == nil && len(entries) > 0 {
		return errors.New("refusing to use a nonempty unowned installation directory")
	}
	binDir := filepath.Join(root, "bin")
	if runtime.GOOS != "windows" && requested == "" {
		home, _ := os.UserHomeDir()
		binDir = filepath.Join(home, ".local", "bin")
	}
	launcher := filepath.Join(binDir, "linkos")
	if runtime.GOOS == "windows" {
		launcher += ".cmd"
	}
	if found, e := exec.LookPath("linkos"); requested == "" && e == nil && !sameFilePath(found, launcher) {
		return fmt.Errorf("unrelated linkos command already exists at %s; remove the conflict explicitly", found)
	}
	if current, e := os.ReadFile(launcher); e == nil {
		sum := sha256.Sum256(current)
		if previous.Owner != "linkos-cli/1" || previous.LauncherSHA256 != hex.EncodeToString(sum[:]) {
			return errors.New("refusing to overwrite an unowned or modified linkos launcher")
		}
	}
	if err = os.MkdirAll(binDir, 0755); err != nil {
		return err
	}
	versionDir := filepath.Join(root, "versions", identity)
	if err = os.MkdirAll(versionDir, 0755); err != nil {
		return err
	}
	name := "linkos"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	installed := filepath.Join(versionDir, name)
	if old, e := os.ReadFile(installed); e != nil {
		if !os.IsNotExist(e) {
			return e
		}
		if err = os.WriteFile(installed, raw, 0755); err != nil {
			return err
		}
	} else {
		sum := sha256.Sum256(old)
		if sum != digest {
			return errors.New("installed immutable binary checksum mismatch")
		}
	}
	content := "#!/bin/sh\nexec '" + strings.ReplaceAll(installed, "'", "'\"'\"'") + "' \"$@\"\n"
	if runtime.GOOS == "windows" {
		if strings.ContainsAny(installed, "%\r\n") {
			return errors.New("installation path cannot contain percent or newlines on Windows")
		}
		content = "@echo off\r\n\"" + installed + "\" %*\r\n"
	}
	temp, err := os.CreateTemp(binDir, ".linkos-launcher-*")
	if err != nil {
		return err
	}
	tempName := temp.Name()
	defer os.Remove(tempName)
	_, err = temp.WriteString(content)
	if closeErr := temp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err = os.Chmod(tempName, 0755); err != nil {
		return err
	}
	if err = os.Rename(tempName, launcher); err != nil {
		return err
	}
	sum := sha256.Sum256([]byte(content))
	next := userCLIInstall{Owner: "linkos-cli/1", Binary: installed, Launcher: launcher, LauncherSHA256: hex.EncodeToString(sum[:])}
	if err = writePrivateJSON(marker, next); err != nil {
		return err
	}
	if requested == "" {
		if err = updateUserCLIPath(binDir, true); err != nil {
			return err
		}
	}
	fmt.Printf("Installed %s\nCommand: %s\nOpen a new terminal if PATH changed. Running instances continue using their existing binary.\n", installed, launcher)
	return nil
}
func sameFilePath(a, b string) bool {
	a, _ = filepath.Abs(a)
	b, _ = filepath.Abs(b)
	if runtime.GOOS == "windows" {
		return strings.EqualFold(a, b)
	}
	return a == b
}
func uninstallUserCLI(args []string) error {
	f, w, err := projectArguments(args)
	if err != nil {
		return err
	}
	if len(w) > 0 {
		return errors.New("unexpected uninstall arguments")
	}
	root := f["install-dir"]
	if root == "" {
		root = defaultCLIInstallDir()
	}
	root, err = filepath.Abs(root)
	if err != nil {
		return err
	}
	installLock, err := acquireDataLock(root + ".install")
	if err != nil {
		return err
	}
	defer installLock.Close()
	raw, err := os.ReadFile(filepath.Join(root, "install.json"))
	if err != nil {
		return err
	}
	var state userCLIInstall
	if json.Unmarshal(raw, &state) != nil || state.Owner != "linkos-cli/1" {
		return errors.New("not a LinkOS CLI installation")
	}
	// Never recursively remove a computed installation tree or a running binary.
	launcher := filepath.Join(root, "bin", "linkos")
	if runtime.GOOS == "windows" {
		launcher += ".cmd"
	} else if f["install-dir"] == "" {
		home, _ := os.UserHomeDir()
		launcher = filepath.Join(home, ".local", "bin", "linkos")
	}
	if !sameFilePath(launcher, state.Launcher) {
		return errors.New("installation launcher path mismatch")
	}
	content, err := os.ReadFile(launcher)
	if err != nil {
		return err
	}
	sum := sha256.Sum256(content)
	if hex.EncodeToString(sum[:]) != state.LauncherSHA256 {
		return errors.New("launcher was modified; refusing removal")
	}
	if err = os.Remove(launcher); err != nil {
		return err
	}
	if f["install-dir"] == "" {
		if err = updateUserCLIPath(filepath.Dir(launcher), false); err != nil {
			return err
		}
	}
	fmt.Printf("Removed command %s. Version binaries and workspace data are retained at %s.\n", launcher, root)
	return nil
}
