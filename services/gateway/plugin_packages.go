package main

import (
	"archive/zip"
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	protocol "github.com/Lee-zg/linkos/services/gateway/mvptypes"
)

const maxPluginArchive = 50 * 1024 * 1024
const maxPluginExpanded = 128 * 1024 * 1024
const maxPluginFile = 16 * 1024 * 1024

type pluginFileHash struct {
	Path   string `json:"path"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}
type pluginChecksums struct {
	Format int              `json:"format"`
	Files  []pluginFileHash `json:"files"`
}

var pluginVersionPattern = regexp.MustCompile(`^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$`)
var pluginDevicePattern = regexp.MustCompile(`^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$`)

func pluginWindowsName(name string) bool {
	return strings.TrimRight(name, ". ") == name && !strings.ContainsAny(name, `<>"|?*`) && !pluginDevicePattern.MatchString(strings.ToUpper(strings.Split(name, ".")[0]))
}

func validateUIPackage(manifest protocol.PluginManifest) error {
	if len(validatePluginManifest(manifest)) > 0 {
		return failPlugin(400, "PLUGIN_INCOMPATIBLE", "manifest 的 ID、名称、版本或入口无效")
	}
	if !pluginWindowsName(manifest.ID) {
		return failPlugin(400, "PLUGIN_INCOMPATIBLE", "插件 ID 不兼容 Windows 数据目录")
	}
	if builtinPlugin(manifest.ID) {
		return failPlugin(409, "PLUGIN_BUILTIN_MANAGED", "不能用外部包覆盖官方应用")
	}
	if manifest.APIVersion != "1.0" || !pluginVersionPattern.MatchString(manifest.Version) {
		return failPlugin(400, "PLUGIN_INCOMPATIBLE", "插件需要 API 1.0 和语义版本号")
	}
	if len(manifest.Entry) != 1 || manifest.Entry["ui"] == "" || !strings.HasSuffix(strings.ToLower(manifest.Entry["ui"]), ".html") || !strings.HasPrefix(manifest.Entry["ui"], "ui/") || !validPluginAssetPath(manifest.Entry["ui"]) || manifest.Runner != nil {
		return failPlugin(400, "PLUGIN_CAPABILITY_UNSUPPORTED", "首期仅支持 ui/ 下 HTML 入口；service 和 Runner 入口暂不支持")
	}
	if manifest.Network != nil {
		if manifest.Network["mode"] != "deny" || manifest.Network["domains"] != nil {
			return failPlugin(400, "PLUGIN_NETWORK_UNSUPPORTED", "首期插件仅支持 network.mode=deny")
		}
	}
	for _, permission := range manifest.Permissions {
		if permission != "ui.notify" && permission != "ui.command" && !strings.HasPrefix(permission, "resource.read:") && !strings.HasPrefix(permission, "event.subscribe:") {
			return failPlugin(400, "PLUGIN_CAPABILITY_UNSUPPORTED", "不支持的权限: "+permission)
		}
		if strings.ContainsAny(permission, "\r\n\x00") || strings.HasSuffix(permission, ":") {
			return failPlugin(400, "PLUGIN_INCOMPATIBLE", "无效权限声明")
		}
	}
	return nil
}
func (s *mvpStore) cleanupPluginStages() {
	p := s.pluginRuntime
	p.mu.Lock()
	defer p.mu.Unlock()
	now := time.Now()
	for id, stage := range p.stages {
		if now.After(stage.ExpiresAt) {
			if filepath.Dir(stage.directory) == filepath.Join(p.root, ".staging") {
				_ = os.RemoveAll(stage.directory)
			}
			delete(p.stages, id)
		}
	}
	for id, ticket := range p.tickets {
		if now.After(ticket.expires) {
			delete(p.tickets, id)
		}
	}
	for id, rate := range p.rates {
		if rate.inflight == 0 && now.Sub(rate.since) > time.Minute {
			delete(p.rates, id)
		}
	}
}
func permissionDiff(current, next []string) (added, removed []string) {
	added = []string{}
	removed = []string{}
	for _, v := range next {
		found := false
		for _, old := range current {
			if old == v {
				found = true
			}
		}
		if !found {
			added = append(added, v)
		}
	}
	for _, v := range current {
		found := false
		for _, newValue := range next {
			if newValue == v {
				found = true
			}
		}
		if !found {
			removed = append(removed, v)
		}
	}
	sort.Strings(added)
	sort.Strings(removed)
	return
}
func trustedPackageSignature(raw []byte, signature string) bool {
	sig, err := base64.RawStdEncoding.DecodeString(signature)
	if err != nil || len(sig) != ed25519.SignatureSize {
		sig, err = hex.DecodeString(signature)
	}
	if err != nil {
		return false
	}
	for _, key := range pluginTrustedKeys() {
		if ed25519.Verify(key, raw, sig) {
			return true
		}
	}
	return false
}
func readZipFile(file *zip.File, limit int64) ([]byte, error) {
	if file.UncompressedSize64 > uint64(limit) {
		return nil, failPlugin(413, "PLUGIN_PACKAGE_LIMIT", "插件文件超过大小限制")
	}
	reader, err := file.Open()
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	data, err := io.ReadAll(io.LimitReader(reader, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, failPlugin(413, "PLUGIN_PACKAGE_LIMIT", "插件文件超过大小限制")
	}
	return data, nil
}
func (s *mvpStore) inspectPackage(raw []byte, principal authPrincipal) (*stagedPlugin, error) {
	if len(raw) > maxPluginArchive {
		return nil, failPlugin(413, "PLUGIN_PACKAGE_LIMIT", "插件包超过 50 MiB")
	}
	archive, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		return nil, failPlugin(400, "PLUGIN_PACKAGE_INVALID", "需要有效 ZIP 插件包")
	}
	if len(archive.File) > 1000 {
		return nil, failPlugin(413, "PLUGIN_PACKAGE_LIMIT", "插件包超过 1000 个文件")
	}
	files := map[string]*zip.File{}
	names := map[string]bool{}
	var total uint64
	for _, file := range archive.File {
		name := file.Name
		if file.FileInfo().IsDir() {
			name = strings.TrimSuffix(name, "/")
		}
		if !validPluginAssetPath(name) || file.Mode()&os.ModeSymlink != 0 || strings.ContainsAny(name, "\x00") {
			return nil, failPlugin(400, "PLUGIN_PACKAGE_INVALID", "插件包包含危险路径或符号链接")
		}
		// Windows cannot distinguish case, trailing dots/spaces, device names or ADS.
		for _, part := range strings.Split(name, "/") {
			if !pluginWindowsName(part) {
				return nil, failPlugin(400, "PLUGIN_PACKAGE_INVALID", "不兼容 Windows 的插件路径")
			}
		}
		lower := strings.ToLower(name)
		if names[lower] {
			return nil, failPlugin(400, "PLUGIN_PACKAGE_INVALID", "插件包包含重复或大小写冲突路径")
		}
		names[lower] = true
		if file.FileInfo().IsDir() {
			continue
		}
		if file.UncompressedSize64 > maxPluginFile {
			return nil, failPlugin(413, "PLUGIN_PACKAGE_LIMIT", "插件文件超过 16 MiB")
		}
		total += file.UncompressedSize64
		if total > maxPluginExpanded {
			return nil, failPlugin(413, "PLUGIN_PACKAGE_LIMIT", "解压内容超过 128 MiB")
		}
		files[name] = file
	}
	if files["manifest.json"] == nil || files["checksums.json"] == nil {
		return nil, failPlugin(400, "PLUGIN_PACKAGE_INVALID", "插件包缺少 manifest.json 或 checksums.json")
	}
	manifestRaw, err := readZipFile(files["manifest.json"], 128*1024)
	if err != nil {
		return nil, err
	}
	var manifest protocol.PluginManifest
	if json.Unmarshal(manifestRaw, &manifest) != nil {
		return nil, failPlugin(400, "PLUGIN_INCOMPATIBLE", "manifest JSON 无效")
	}
	if err = validateUIPackage(manifest); err != nil {
		return nil, err
	}
	checksumRaw, err := readZipFile(files["checksums.json"], 1024*1024)
	if err != nil {
		return nil, err
	}
	var checks pluginChecksums
	if json.Unmarshal(checksumRaw, &checks) != nil || checks.Format != 1 {
		return nil, failPlugin(400, "PLUGIN_PACKAGE_INVALID", "不支持的校验清单格式")
	}
	signature := ""
	if file := files["signature.ed25519"]; file != nil {
		data, err := readZipFile(file, 1024)
		if err != nil {
			return nil, err
		}
		signature = strings.TrimSpace(string(data))
	}
	trusted := signature != "" && trustedPackageSignature(checksumRaw, signature)
	if signature != "" && !trusted || pluginSignaturesRequired() && !trusted {
		return nil, failPlugin(400, "PLUGIN_SIGNATURE_INVALID", "插件签名不受信任；生产环境需要配置受信公钥")
	}
	count := len(files) - 1
	if signature != "" {
		count--
	}
	if len(checks.Files) != count {
		return nil, failPlugin(400, "PLUGIN_PACKAGE_INVALID", "校验清单必须覆盖全部资源")
	}
	root, err := s.packageRoot()
	if err != nil {
		return nil, err
	}
	stagingRoot := filepath.Join(root, ".staging")
	if err = os.MkdirAll(stagingRoot, 0700); err != nil {
		return nil, err
	}
	directory, err := os.MkdirTemp(stagingRoot, "package-")
	if err != nil {
		return nil, err
	}
	committed := false
	defer func() {
		if !committed {
			os.RemoveAll(directory)
		}
	}()
	seen := map[string]bool{}
	for _, hash := range checks.Files {
		file := files[hash.Path]
		if file == nil || seen[hash.Path] || hash.Path == "checksums.json" || hash.Path == "signature.ed25519" || hash.Size < 0 || hash.Size > maxPluginFile {
			return nil, failPlugin(400, "PLUGIN_PACKAGE_INVALID", "校验清单包含重复或无效资源")
		}
		seen[hash.Path] = true
		if hash.Path != "manifest.json" && !strings.HasPrefix(hash.Path, "ui/") {
			return nil, failPlugin(400, "PLUGIN_PACKAGE_INVALID", "运行资源必须位于 ui/ 目录")
		}
		data, err := readZipFile(file, maxPluginFile)
		if err != nil {
			return nil, err
		}
		sum := sha256.Sum256(data)
		if int64(len(data)) != hash.Size || hex.EncodeToString(sum[:]) != hash.SHA256 {
			return nil, failPlugin(400, "PLUGIN_RESOURCE_INVALID", "插件资源校验失败: "+hash.Path)
		}
		destination := filepath.Join(directory, filepath.FromSlash(hash.Path))
		if err = os.MkdirAll(filepath.Dir(destination), 0700); err != nil {
			return nil, err
		}
		if err = os.WriteFile(destination, data, 0600); err != nil {
			return nil, err
		}
	}
	if !seen["manifest.json"] || !seen[manifest.Entry["ui"]] {
		return nil, failPlugin(400, "PLUGIN_RESOURCE_MISSING", "插件入口未包含在完整资源清单中")
	}
	if err = os.WriteFile(filepath.Join(directory, "checksums.json"), checksumRaw, 0600); err != nil {
		return nil, err
	}
	if signature != "" {
		if err = os.WriteFile(filepath.Join(directory, "signature.ed25519"), []byte(signature), 0600); err != nil {
			return nil, err
		}
	}
	digest := sha256.Sum256(checksumRaw)
	stage := &stagedPlugin{ID: randomSecret(), Manifest: manifest, Digest: hex.EncodeToString(digest[:]), Signature: signature, Trusted: trusted, ExpiresAt: time.Now().Add(15 * time.Minute), directory: directory, token: principal.Token}
	s.mu.RLock()
	current := s.state.Plugins[manifest.ID]
	s.mu.RUnlock()
	stage.ExpectedRevision = current.Revision
	stage.AddedPermissions, stage.RemovedPermissions = permissionDiff(current.Permissions, manifest.Permissions)
	p := s.pluginRuntime
	p.mu.Lock()
	p.stages[stage.ID] = stage
	p.mu.Unlock()
	committed = true
	return stage, nil
}
func (s *mvpStore) handlePluginPackageInspect(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		writeAPIError(w, 405, "INVALID_REQUEST", "method not allowed")
		return
	}
	principal, _ := principalForRequest(s.authFromHub(), r)
	if !roleAllows(principal.Role, "plugin.install") {
		writeAPIError(w, 403, "FORBIDDEN", "plugin.install permission required")
		return
	}
	if !s.beginPluginRPC("inspect:"+principal.UserID, 2, 1) {
		writeAPIError(w, 429, "PLUGIN_RATE_LIMIT", "插件检查正在进行或请求过于频繁")
		return
	}
	defer s.endPluginRPC("inspect:" + principal.UserID)
	s.cleanupPluginStages()
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxPluginArchive))
	if err != nil {
		writeAPIError(w, 413, "PLUGIN_PACKAGE_LIMIT", "插件包超过 50 MiB")
		return
	}
	stage, err := s.inspectPackage(raw, principal)
	if err != nil {
		writePluginError(w, err)
		return
	}
	writeJSON(w, 200, stage)
}
func (s *mvpStore) packageDirectory(rec protocol.PluginRecord) (string, error) {
	if rec.ArtifactDigest == "" || len(rec.ArtifactDigest) != 64 || !isPluginID(rec.ID) || !pluginVersionPattern.MatchString(rec.Version) {
		return "", failPlugin(409, "PLUGIN_RESOURCE_MISSING", "插件没有完整版本资源，请重新安装")
	}
	if _, err := hex.DecodeString(rec.ArtifactDigest); err != nil {
		return "", failPlugin(409, "PLUGIN_RESOURCE_INVALID", "资源摘要无效")
	}
	root, err := s.packageRoot()
	if err != nil {
		return "", err
	}
	return filepath.Join(root, rec.ID, rec.Version, rec.ArtifactDigest), nil
}
func (s *mvpStore) readManagedPluginAsset(rec protocol.PluginRecord, name string) ([]byte, error) {
	if !validPluginAssetPath(name) || !strings.HasPrefix(name, "ui/") {
		return nil, failPlugin(400, "PLUGIN_RESOURCE_INVALID", "只能读取 UI 资源")
	}
	if rec.Source == "builtin" {
		return readPluginAsset(rec.ID, name, rec.Signature)
	}
	directory, err := s.packageDirectory(rec)
	if err != nil {
		return nil, err
	}
	return readVerifiedPluginAsset(directory, rec.ArtifactDigest, name)
}
func readVerifiedPluginAsset(directory, digest, name string) ([]byte, error) {
	raw, err := readPackageFile(directory, "checksums.json")
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(raw)
	if hex.EncodeToString(sum[:]) != digest {
		return nil, failPlugin(409, "PLUGIN_RESOURCE_INVALID", "校验清单被修改")
	}
	var checks pluginChecksums
	if json.Unmarshal(raw, &checks) != nil || checks.Format != 1 {
		return nil, failPlugin(409, "PLUGIN_RESOURCE_INVALID", "校验清单无效")
	}
	for _, entry := range checks.Files {
		if entry.Path != name {
			continue
		}
		data, err := readPackageFile(directory, name)
		if err != nil {
			return nil, err
		}
		sum := sha256.Sum256(data)
		if int64(len(data)) != entry.Size || hex.EncodeToString(sum[:]) != entry.SHA256 {
			return nil, failPlugin(409, "PLUGIN_RESOURCE_INVALID", "资源损坏: "+name)
		}
		return data, nil
	}
	return nil, failPlugin(404, "PLUGIN_RESOURCE_MISSING", "资源未包含在校验清单中")
}
func readPackageFile(directory, name string) ([]byte, error) {
	if !validPluginAssetPath(name) {
		return nil, failPlugin(400, "PLUGIN_RESOURCE_INVALID", "资源路径无效")
	}
	current := directory
	for _, part := range append([]string{""}, strings.Split(name, "/")...) {
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if err != nil {
			return nil, err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return nil, failPlugin(400, "PLUGIN_RESOURCE_INVALID", "不允许资源符号链接")
		}
	}
	return os.ReadFile(current)
}
func (s *mvpStore) verifyPluginResources(rec protocol.PluginRecord) error {
	directory, err := s.packageDirectory(rec)
	if err != nil {
		return err
	}
	raw, err := readPackageFile(directory, "checksums.json")
	if err != nil {
		return failPlugin(409, "PLUGIN_RESOURCE_MISSING", "校验清单缺失")
	}
	sum := sha256.Sum256(raw)
	if hex.EncodeToString(sum[:]) != rec.ArtifactDigest {
		return failPlugin(409, "PLUGIN_RESOURCE_INVALID", "校验清单被修改")
	}
	var checks pluginChecksums
	if json.Unmarshal(raw, &checks) != nil {
		return failPlugin(409, "PLUGIN_RESOURCE_INVALID", "校验清单无效")
	}
	for _, file := range checks.Files {
		data, err := readPackageFile(directory, file.Path)
		if err != nil {
			return failPlugin(409, "PLUGIN_RESOURCE_MISSING", "资源缺失: "+file.Path)
		}
		sum := sha256.Sum256(data)
		if int64(len(data)) != file.Size || hex.EncodeToString(sum[:]) != file.SHA256 {
			return failPlugin(409, "PLUGIN_RESOURCE_INVALID", "资源损坏: "+file.Path)
		}
	}
	return nil
}
func (s *mvpStore) installStagedPlugin(id, stageID string, revision int64, probeNonce string, principal authPrincipal) (protocol.PluginRecord, error) {
	p := s.pluginRuntime
	p.mu.Lock()
	defer p.mu.Unlock()
	stage := p.stages[stageID]
	if stage == nil || stage.token != principal.Token || time.Now().After(stage.ExpiresAt) || stage.Manifest.ID != id {
		return protocol.PluginRecord{}, failPlugin(409, "PLUGIN_STAGE_EXPIRED", "检查结果已过期，请重新上传")
	}
	ticket, ok := p.tickets[probeNonce]
	if !ok || ticket.stageID != stageID || ticket.token != principal.Token || time.Now().After(ticket.expires) {
		return protocol.PluginRecord{}, failPlugin(409, "PLUGIN_PROBE_REQUIRED", "请先确认权限并完成隔离启动检查")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	current := s.state.Plugins[id]
	if current.Revision != revision || stage.ExpectedRevision != revision {
		return current, failPlugin(409, "PLUGIN_REVISION_CONFLICT", "插件版本已变化，请重新检查")
	}
	if current.Version == stage.Manifest.Version && current.ArtifactDigest != "" && current.ArtifactDigest != stage.Digest {
		return current, failPlugin(409, "PLUGIN_VERSION_CONFLICT", "同一版本不能对应不同资源，请提高版本号")
	}
	root := p.root
	directory := filepath.Join(root, id, stage.Manifest.Version, stage.Digest)
	if err := os.MkdirAll(filepath.Dir(directory), 0700); err != nil {
		return current, err
	}
	if _, err := os.Stat(directory); os.IsNotExist(err) {
		if err = os.Rename(stage.directory, directory); err != nil {
			return current, err
		}
		stage.directory = directory
	} else if err != nil {
		return current, err
	}
	rec := protocol.PluginRecord{ID: id, Name: stage.Manifest.Name, Version: stage.Manifest.Version, APIVersion: stage.Manifest.APIVersion, Status: "installed", Manifest: stage.Manifest, Signature: stage.Signature, Permissions: stage.Manifest.Permissions, Health: "healthy", InstalledAt: time.Now().UTC().Format(time.RFC3339), Source: "package", Runtime: "iframe", Revision: revision + 1, ArtifactDigest: stage.Digest}
	if current.ArtifactDigest != "" && current.ArtifactDigest != stage.Digest {
		rec.Previous = &protocol.PluginPrevious{Manifest: current.Manifest, Signature: current.Signature, Status: current.Status, ArtifactDigest: current.ArtifactDigest, Source: current.Source}
	}
	if current.ArtifactDigest == stage.Digest {
		rec.Previous = current.Previous
	}
	if current.Status == "enabled" || current.Status == "disabled" {
		rec.Status = current.Status
	}
	if err := s.verifyPluginResources(rec); err != nil {
		return current, err
	}
	// All bytes were validated before the atomic registry commit. Orphaned immutable
	// versions are safe to retain if committing fails; never delete an active package.
	if err := s.commitPluginLocked(rec); err != nil {
		return current, err
	}
	delete(p.stages, stageID)
	delete(p.tickets, probeNonce)
	if filepath.Dir(stage.directory) == filepath.Join(p.root, ".staging") {
		_ = os.RemoveAll(stage.directory)
	}
	return rec, nil
}
func (s *mvpStore) checkManagedPluginHealth() {
	s.cleanupPluginStages()
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, rec := range s.state.Plugins {
		if rec.Status != "enabled" || rec.Source == "builtin" {
			continue
		}
		if err := s.verifyPluginResources(rec); err != nil {
			message := err.Error()
			candidate := rec
			if rec.Previous != nil && rec.Previous.ArtifactDigest != "" {
				previous := rec.Previous
				candidate.Manifest = previous.Manifest
				candidate.Name = previous.Manifest.Name
				candidate.Version = previous.Manifest.Version
				candidate.APIVersion = previous.Manifest.APIVersion
				candidate.Permissions = previous.Manifest.Permissions
				candidate.ArtifactDigest = previous.ArtifactDigest
				candidate.Signature = previous.Signature
				candidate.Source = previous.Source
				candidate.Status = previous.Status
				candidate.Previous = nil
				if s.verifyPluginResources(candidate) != nil {
					candidate = rec
					candidate.Status = "failed"
				}
			} else {
				candidate.Status = "failed"
			}
			candidate.Health = "degraded"
			candidate.HealthReason = message
			candidate.Revision++
			if s.commitPluginLocked(candidate) == nil {
				s.hub.emit("plugin.updated", candidate)
			}
		}
	}
}
