package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func newTestAuth() *authStore {
	return newAuthStore("demo", "test-passcode", newAccessPolicy(), newAccessStore())
}

func issueLogin(t *testing.T, auth *authStore, name string) authPrincipal {
	t.Helper()
	principal, _, errCode := auth.issueSession(sessionRequest{
		WorkspaceID: "demo",
		DisplayName: name,
		AccessType:  "login",
	})
	if errCode != "" {
		t.Fatalf("issue login session failed: %s", errCode)
	}
	return principal
}

func TestLoginSessionIssuesAndValidatesWorkspaceSession(t *testing.T) {
	auth := newTestAuth()
	principal := issueLogin(t, auth, "测试设备")
	if principal.Token == "" || principal.WorkspaceID != "demo" {
		t.Fatalf("unexpected principal: %#v", principal)
	}
	if principal.Role != "member" || principal.AccessType != "login" || principal.Status != "active" {
		t.Fatalf("unexpected principal fields: %#v", principal)
	}

	request := httptest.NewRequest(http.MethodGet, "/api/v1/resources", nil)
	request.Header.Set("Authorization", "Bearer "+principal.Token)
	validated, ok := auth.authenticateRequest(request, "demo")
	if !ok || validated.UserID != principal.UserID {
		t.Fatalf("expected valid session, got %#v, %v", validated, ok)
	}

	request.Header.Set("Authorization", "Bearer invalid")
	if _, ok := auth.authenticateRequest(request, "demo"); ok {
		t.Fatal("expected invalid token to be rejected")
	}
	if _, ok := auth.authenticateRequest(request, "other"); ok {
		t.Fatal("expected workspace mismatch to be rejected")
	}
}

func TestAuthStoreRejectsExpiredSession(t *testing.T) {
	auth := newTestAuth()
	principal := issueLogin(t, auth, "过期设备")

	auth.mu.Lock()
	stored := auth.sessions[principal.Token]
	stored.ExpiresAt = time.Now().UTC().Add(-time.Minute)
	auth.sessions[principal.Token] = stored
	auth.mu.Unlock()

	request := httptest.NewRequest(http.MethodGet, "/api/v1/resources", nil)
	request.Header.Set("Authorization", "Bearer "+principal.Token)
	if _, ok := auth.authenticateRequest(request, "demo"); ok {
		t.Fatal("expected expired token to be rejected")
	}
	auth.mu.Lock()
	_, stillStored := auth.sessions[principal.Token]
	auth.mu.Unlock()
	if stillStored {
		t.Fatal("expired token should be removed")
	}
}

func TestRequireActiveReturnsUnauthorizedWithoutSession(t *testing.T) {
	auth := newTestAuth()
	handler := requireActive(auth, "demo", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})

	unauthorized := httptest.NewRecorder()
	handler(unauthorized, httptest.NewRequest(http.MethodGet, "/api/v1/resources", nil))
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", unauthorized.Code)
	}

	principal := issueLogin(t, auth, "有效设备")
	authorizedRequest := httptest.NewRequest(http.MethodGet, "/api/v1/resources", nil)
	authorizedRequest.Header.Set("Authorization", "Bearer "+principal.Token)
	authorized := httptest.NewRecorder()
	handler(authorized, authorizedRequest)
	if authorized.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", authorized.Code)
	}
}

func TestRefreshRotationAndDeviceSurviveRestart(t *testing.T) {
	path := testSQLitePath(t)
	backend, err := newSQLiteBackend(path)
	if err != nil {
		t.Fatal(err)
	}
	auth := newAuthStore("demo", "test-passcode", newAccessPolicyWithBackend(backend), newAccessStoreWithBackend(backend))
	publicKey, privateKey := newDeviceTestKey(t)
	principal, _, code := auth.issueSession(sessionRequest{WorkspaceID: "demo", DisplayName: "Persistent device", AccessType: accessTypeLogin, DeviceID: "dev_persistent", PublicKey: publicKey})
	if code != "" {
		t.Fatalf("issue session: %s", code)
	}
	refreshToken := principal.RefreshToken
	if err := backend.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := newSQLiteBackend(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	restored := newAuthStore("demo", "test-passcode", newAccessPolicyWithBackend(reopened), newAccessStoreWithBackend(reopened))
	rotated, ok := restored.rotateRefresh(refreshToken)
	if !ok || rotated.UserID != principal.UserID || rotated.DeviceID != "dev_persistent" {
		t.Fatalf("unexpected rotated principal: %+v ok=%t", rotated, ok)
	}
	if _, reused := restored.rotateRefresh(refreshToken); reused {
		t.Fatal("refresh tokens must be single use")
	}
	if len(restored.listDevices()) != 1 {
		t.Fatalf("device registration did not survive restart: %+v", restored.listDevices())
	}
	challenge, _ := restored.createDeviceChallenge("demo", principal.DeviceID)
	relogged, _, code := restored.issueSession(sessionRequest{DisplayName: "Restored", DeviceID: principal.DeviceID,
		ChallengeID: challenge.ID, Signature: signDeviceTestChallenge(privateKey, challenge.Message)})
	if code != "" || relogged.UserID != principal.UserID {
		t.Fatalf("registered key must restore identity after restart: code=%q sameUser=%t", code, relogged.UserID == principal.UserID)
	}
}

func TestGuestSessionGetsGuestRoleAndCannotWrite(t *testing.T) {
	auth := newTestAuth()
	auth.policy.set(false, true)
	guest, _, errCode := auth.issueSession(sessionRequest{WorkspaceID: "demo", AccessType: accessTypeGuest})
	if errCode != "" {
		t.Fatalf("issue guest: %s", errCode)
	}
	if guest.Role != "guest" {
		t.Fatalf("expected guest role, got %q", guest.Role)
	}
	if roleAllows(guest.Role, "resource.write") {
		t.Fatal("guest role must not allow resource.write")
	}
	if roleAllows(guest.Role, "chat.send") {
		t.Fatal("guest role must not allow chat.send")
	}

	rotated, ok := auth.rotateRefresh(guest.RefreshToken)
	if !ok {
		t.Fatal("guest refresh should succeed")
	}
	if rotated.Role != "guest" {
		t.Fatalf("refreshed guest should keep guest role, got %q", rotated.Role)
	}
	if roleAllows(rotated.Role, "resource.write") {
		t.Fatal("refreshed guest must not gain write permissions")
	}
}

func TestDeviceIdReuseWithoutChallengeRejected(t *testing.T) {
	auth := newTestAuth()
	publicKey, _ := newDeviceTestKey(t)
	first, _, errCode := auth.issueSession(sessionRequest{
		WorkspaceID: "demo", DisplayName: "Original", AccessType: accessTypeLogin,
		DeviceID: "dev_known", PublicKey: publicKey,
	})
	if errCode != "" {
		t.Fatalf("first issue: %s", errCode)
	}

	_, _, errCode = auth.issueSession(sessionRequest{
		WorkspaceID: "demo", DisplayName: "Impostor", AccessType: accessTypeLogin,
		DeviceID: "dev_known",
	})
	if errCode != "DEVICE_CHALLENGE_REQUIRED" {
		t.Fatalf("expected DEVICE_CHALLENGE_REQUIRED, got %q", errCode)
	}

	auth.revokeDevice("dev_known")
	_, _, errCode = auth.issueSession(sessionRequest{
		WorkspaceID: "demo", DisplayName: "After Revoke", AccessType: accessTypeLogin,
		DeviceID: "dev_known", PublicKey: publicKey,
	})
	if errCode != "INVALID_REQUEST" {
		t.Fatalf("expected revoked device to be rejected, got %q", errCode)
	}
	_ = first
}

func TestPublicKeyReplacementCannotReuseUserID(t *testing.T) {
	auth := newTestAuth()
	publicKey, _ := newDeviceTestKey(t)
	otherPublicKey, _ := newDeviceTestKey(t)
	original, _, errCode := auth.issueSession(sessionRequest{
		WorkspaceID: "demo", DisplayName: "Original", AccessType: accessTypeLogin,
		DeviceID: "dev_pubkey", PublicKey: publicKey,
	})
	if errCode != "" {
		t.Fatalf("first issue: %s", errCode)
	}

	_, _, errCode = auth.issueSession(sessionRequest{
		WorkspaceID: "demo", DisplayName: "Different", AccessType: accessTypeLogin,
		DeviceID: "dev_pubkey", PublicKey: otherPublicKey,
	})
	if errCode != "DEVICE_CHALLENGE_REQUIRED" {
		t.Fatalf("expected challenge required for different public key, got %q", errCode)
	}
	_ = original
}

func TestDeviceChallengeFlow(t *testing.T) {
	auth := newTestAuth()
	publicKey, privateKey := newDeviceTestKey(t)
	original, _, errCode := auth.issueSession(sessionRequest{
		WorkspaceID: "demo", DisplayName: "Original", AccessType: accessTypeLogin,
		DeviceID: "dev_challenge", PublicKey: publicKey,
	})
	if errCode != "" {
		t.Fatalf("first issue: %s", errCode)
	}
	auth.revokeSession(original.Token)

	challenge, errCode := auth.createDeviceChallenge("demo", "dev_challenge")
	if errCode != "" {
		t.Fatalf("create challenge: %s", errCode)
	}
	if challenge.WorkspaceID != "demo" || challenge.DeviceID != "dev_challenge" {
		t.Fatalf("unexpected challenge scope: %+v", challenge)
	}

	_, _, errCode = auth.issueSession(sessionRequest{
		WorkspaceID: "demo", DisplayName: "Again", AccessType: accessTypeLogin,
		DeviceID: "dev_challenge", PublicKey: publicKey,
	})
	if errCode != "DEVICE_CHALLENGE_REQUIRED" {
		t.Fatalf("expected challenge required without response, got %q", errCode)
	}

	_, _, errCode = auth.issueSession(sessionRequest{
		WorkspaceID: "demo", DisplayName: "Again", AccessType: accessTypeLogin,
		DeviceID: "dev_challenge", PublicKey: publicKey,
		ChallengeID: challenge.ID, Signature: "wrong-signature",
	})
	if errCode != "DEVICE_CHALLENGE_FAILED" {
		t.Fatalf("expected bad signature rejected, got %q", errCode)
	}

	_, _, errCode = auth.issueSession(sessionRequest{
		WorkspaceID: "demo", DisplayName: "Again", AccessType: accessTypeLogin,
		DeviceID: "dev_challenge", PublicKey: publicKey,
		ChallengeID: "nonexistent", Signature: "whatever",
	})
	if errCode != "DEVICE_CHALLENGE_FAILED" {
		t.Fatalf("expected unknown challenge rejected, got %q", errCode)
	}

	freshChallenge, _ := auth.createDeviceChallenge("demo", "dev_challenge")
	freshChallenge.ExpiresAt = time.Now().UTC().Add(-time.Minute)
	auth.mu.Lock()
	auth.challenges[freshChallenge.ID] = freshChallenge
	auth.mu.Unlock()
	_, _, errCode = auth.issueSession(sessionRequest{
		WorkspaceID: "demo", DisplayName: "Again", AccessType: accessTypeLogin,
		DeviceID: "dev_challenge", PublicKey: publicKey,
		ChallengeID: freshChallenge.ID, Signature: signDeviceTestChallenge(privateKey, freshChallenge.Message),
	})
	if errCode != "DEVICE_CHALLENGE_FAILED" {
		t.Fatalf("expected expired challenge rejected, got %q", errCode)
	}

	wrongChallenge, _ := auth.createDeviceChallenge("other", "dev_challenge")
	_, _, errCode = auth.issueSession(sessionRequest{
		WorkspaceID: "demo", DisplayName: "Again", AccessType: accessTypeLogin,
		DeviceID: "dev_challenge", PublicKey: publicKey,
		ChallengeID: wrongChallenge.ID, Signature: "whatever",
	})
	if errCode != "DEVICE_CHALLENGE_FAILED" {
		t.Fatalf("expected wrong workspace challenge rejected, got %q", errCode)
	}

	validChallenge, _ := auth.createDeviceChallenge("demo", "dev_challenge")
	signature := signDeviceTestChallenge(privateKey, validChallenge.Message)
	second, _, errCode := auth.issueSession(sessionRequest{
		WorkspaceID: "demo", DisplayName: "Again", AccessType: accessTypeLogin,
		DeviceID: "dev_challenge", PublicKey: publicKey,
		ChallengeID: validChallenge.ID, Signature: signature,
	})
	if errCode != "" {
		t.Fatalf("expected valid challenge accepted, got %s", errCode)
	}
	if second.UserID != original.UserID {
		t.Fatalf("expected same UserID after challenge, got %q vs %q", second.UserID, original.UserID)
	}
	if second.DeviceID != "dev_challenge" {
		t.Fatalf("expected same DeviceID, got %q", second.DeviceID)
	}

	_, _, errCode = auth.issueSession(sessionRequest{
		WorkspaceID: "demo", DisplayName: "Replay", AccessType: accessTypeLogin,
		DeviceID: "dev_challenge", PublicKey: publicKey,
		ChallengeID: validChallenge.ID, Signature: signature,
	})
	if errCode != "DEVICE_CHALLENGE_FAILED" {
		t.Fatalf("expected challenge replay rejected, got %q", errCode)
	}

	if !auth.revokeSession(second.Token) {
		t.Fatal("logout should revoke the second session")
	}
	_, _, errCode = auth.issueSession(sessionRequest{
		WorkspaceID: "demo", DisplayName: "After Logout", AccessType: accessTypeLogin,
		DeviceID: "dev_challenge", PublicKey: publicKey,
	})
	if errCode != "DEVICE_CHALLENGE_REQUIRED" {
		t.Fatalf("expected challenge required after logout, got %q", errCode)
	}
	freshChallenge2, _ := auth.createDeviceChallenge("demo", "dev_challenge")
	sig2 := signDeviceTestChallenge(privateKey, freshChallenge2.Message)
	fourth, _, errCode := auth.issueSession(sessionRequest{
		WorkspaceID: "demo", DisplayName: "After Logout", AccessType: accessTypeLogin,
		DeviceID: "dev_challenge", PublicKey: publicKey,
		ChallengeID: freshChallenge2.ID, Signature: sig2,
	})
	if errCode != "" {
		t.Fatalf("expected post-logout challenge accepted, got %s", errCode)
	}
	if fourth.UserID != original.UserID {
		t.Fatalf("identity must survive logout/re-login, got %q vs %q", fourth.UserID, original.UserID)
	}
}

func TestRefreshPreservesGuestRoleStably(t *testing.T) {
	for _, privilegedRole := range []string{roleMember, roleAdmin} {
		t.Run(privilegedRole, func(t *testing.T) {
			auth := newTestAuth()
			auth.policy.set(false, true)
			publicKey, privateKey := newDeviceTestKey(t)
			guest, _, code := auth.issueSession(sessionRequest{
				WorkspaceID: "demo", AccessType: accessTypeGuest, DeviceID: "dev_shared", PublicKey: publicKey,
			})
			if code != "" {
				t.Fatalf("issue guest: %s", code)
			}
			challenge, code := auth.createDeviceChallenge("demo", guest.DeviceID)
			if code != "" {
				t.Fatalf("create challenge: %s", code)
			}
			req := sessionRequest{DisplayName: "Privileged", DeviceID: guest.DeviceID,
				ChallengeID: challenge.ID, Signature: signDeviceTestChallenge(privateKey, challenge.Message)}
			if privilegedRole == roleAdmin {
				req.Passcode = "test-passcode"
			}
			privileged, _, code := auth.issueSession(req)
			if code != "" || privileged.Role != privilegedRole || privileged.UserID != guest.UserID || privileged.DeviceID != guest.DeviceID {
				t.Fatalf("same-device login: code=%q role=%q sameUser=%t sameDevice=%t", code, privileged.Role,
					privileged.UserID == guest.UserID, privileged.DeviceID == guest.DeviceID)
			}

			refreshToken := guest.RefreshToken
			for i := 0; i < 2; i++ {
				// Model expired guest access tokens. The only possible session-map
				// match is privileged, so this must not depend on map iteration order.
				auth.mu.Lock()
				auth.sessions = map[string]authPrincipal{privileged.Token: privileged}
				auth.mu.Unlock()
				rotated, ok := auth.rotateRefresh(refreshToken)
				if !ok {
					t.Fatal("guest refresh should succeed")
				}
				if rotated.Role != roleGuest || rotated.AccessType != accessTypeGuest || rotated.Status != guest.Status || rotated.DisplayName != guest.DisplayName {
					t.Fatalf("guest refresh inherited another session: role=%q accessType=%q status=%q displayName=%q",
						rotated.Role, rotated.AccessType, rotated.Status, rotated.DisplayName)
				}
				if roleAllows(rotated.Role, "resource.write") || roleAllows(rotated.Role, "chat.send") {
					t.Fatal("refreshed guest must not gain write permissions")
				}
				record := auth.refreshTokens[refreshKey(rotated.RefreshToken)]
				if record.Role != roleGuest || record.AccessType != accessTypeGuest {
					t.Fatal("rotated refresh record must retain guest semantics")
				}
				if _, reused := auth.rotateRefresh(refreshToken); reused {
					t.Fatal("guest refresh token must be single use")
				}
				refreshToken = rotated.RefreshToken
			}
		})
	}
}

func TestRefreshLegacyGuestRemainsReadOnlyAfterRestart(t *testing.T) {
	path := testSQLitePath(t)
	backend, err := newSQLiteBackend(path)
	if err != nil {
		t.Fatal(err)
	}
	defer backend.Close()
	auth := newAuthStore("demo", "test-passcode", newAccessPolicyWithBackend(backend), newAccessStoreWithBackend(backend))
	auth.policy.set(false, true)
	guest, _, code := auth.issueSession(sessionRequest{AccessType: accessTypeGuest})
	if code != "" {
		t.Fatalf("issue guest: %s", code)
	}
	// Before guest-readonly enforcement, guest refresh records carried member.
	auth.mu.Lock()
	record := auth.refreshTokens[refreshKey(guest.RefreshToken)]
	record.Role = roleMember
	auth.refreshTokens[refreshKey(guest.RefreshToken)] = record
	auth.persistAuthLocked()
	auth.mu.Unlock()
	if err := backend.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := newSQLiteBackend(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	restored := newAuthStore("demo", "test-passcode", newAccessPolicyWithBackend(reopened), newAccessStoreWithBackend(reopened))
	rotated, ok := restored.rotateRefresh(guest.RefreshToken)
	if !ok || rotated.Role != roleGuest || rotated.AccessType != accessTypeGuest {
		t.Fatalf("legacy guest refresh must be readonly: ok=%t role=%q accessType=%q", ok, rotated.Role, rotated.AccessType)
	}
	if roleAllows(rotated.Role, "resource.write") || roleAllows(rotated.Role, "chat.send") {
		t.Fatal("legacy guest refresh must not restore write permissions")
	}
	restoredAgain := newAuthStore("demo", "test-passcode", newAccessPolicyWithBackend(reopened), newAccessStoreWithBackend(reopened))
	second, ok := restoredAgain.rotateRefresh(rotated.RefreshToken)
	if !ok || second.Role != roleGuest || second.AccessType != accessTypeGuest {
		t.Fatalf("persisted rotated guest must stay readonly: ok=%t role=%q accessType=%q", ok, second.Role, second.AccessType)
	}
}

func TestRefreshPreservesUpdatedAuthorizationAfterRestart(t *testing.T) {
	for _, status := range []string{accessStatusActive, accessStatusRejected} {
		for _, role := range []string{roleAdmin, roleGuest} {
			t.Run(status+"/"+role, func(t *testing.T) {
				backend, err := newSQLiteBackend(testSQLitePath(t))
				if err != nil {
					t.Fatal(err)
				}
				defer backend.Close()
				auth := newAuthStore("demo", "test-passcode", newAccessPolicyWithBackend(backend), newAccessStoreWithBackend(backend))
				auth.policy.set(true, false)
				principal, _, code := auth.issueSession(sessionRequest{AccessType: accessTypeAnonymous})
				if code != "" {
					t.Fatalf("issue anonymous session: %s", code)
				}
				if !auth.setUserRole(principal.UserID, role) {
					t.Fatal("role update should find the user")
				}
				auth.setUserStatus(principal.UserID, status)
				if updated := auth.sessions[principal.Token]; updated.Role != role || updated.Status != status {
					t.Fatal("access session must reflect authorization updates")
				}
				// Reload without access sessions, so only the persisted refresh
				// record can carry the latest review decision and explicit role.
				restored := newAuthStore("demo", "test-passcode", newAccessPolicyWithBackend(backend), newAccessStoreWithBackend(backend))
				rotated, ok := restored.rotateRefresh(principal.RefreshToken)
				if !ok || rotated.Role != role || rotated.Status != status || rotated.AccessType != accessTypeAnonymous {
					t.Fatalf("refresh must retain authorization updates: ok=%t role=%q status=%q accessType=%q", ok, rotated.Role, rotated.Status, rotated.AccessType)
				}
				request := httptest.NewRequest(http.MethodGet, "/api/v1/resources", nil)
				request.Header.Set("Authorization", "Bearer "+rotated.Token)
				response := httptest.NewRecorder()
				requireActive(restored, "demo", func(w http.ResponseWriter, _ *http.Request) {
					w.WriteHeader(http.StatusOK)
				})(response, request)
				want := http.StatusOK
				if status == accessStatusRejected {
					want = http.StatusForbidden
				}
				if response.Code != want {
					t.Fatalf("refreshed access status: got %d, want %d", response.Code, want)
				}
			})
		}
	}
}

func TestRefreshRespectsRevocationAfterRestart(t *testing.T) {
	for _, scope := range []string{"session", "device"} {
		t.Run(scope, func(t *testing.T) {
			backend, err := newSQLiteBackend(testSQLitePath(t))
			if err != nil {
				t.Fatal(err)
			}
			defer backend.Close()
			auth := newAuthStore("demo", "test-passcode", newAccessPolicyWithBackend(backend), newAccessStoreWithBackend(backend))
			publicKey, _ := newDeviceTestKey(t)
			principal := registerDeviceTestIdentity(t, auth, publicKey)
			if scope == "session" {
				if !auth.revokeSession(principal.Token) {
					t.Fatal("session revocation failed")
				}
			} else if !auth.revokeDevice(principal.DeviceID) {
				t.Fatal("device revocation failed")
			}
			if _, ok := auth.rotateRefresh(principal.RefreshToken); ok {
				t.Fatal("revoked refresh token must not rotate")
			}
			restored := newAuthStore("demo", "test-passcode", newAccessPolicyWithBackend(backend), newAccessStoreWithBackend(backend))
			if _, ok := restored.rotateRefresh(principal.RefreshToken); ok {
				t.Fatal("revoked refresh token must not return after restart")
			}
		})
	}
}

func TestRolePermissionMatrix(t *testing.T) {
	for _, permission := range []string{"workspace.read", "resource.write", "chat.send", "code.write", "job.submit", "plugin.manage", "device.manage"} {
		if !roleAllows("owner", permission) || !roleAllows("admin", permission) {
			t.Fatalf("owner/admin must allow %s", permission)
		}
	}
	if !roleAllows("member", "job.submit") || roleAllows("member", "plugin.manage") {
		t.Fatal("member permission matrix is incorrect")
	}
	if !roleAllows("guest", "resource.read") || roleAllows("guest", "resource.write") {
		t.Fatal("guest permission matrix is incorrect")
	}
}
