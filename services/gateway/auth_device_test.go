package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func newDeviceTestKey(t *testing.T) (string, ed25519.PrivateKey) {
	t.Helper()
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return base64.RawURLEncoding.EncodeToString(publicKey), privateKey
}

func signDeviceTestChallenge(privateKey ed25519.PrivateKey, message string) string {
	return base64.RawURLEncoding.EncodeToString(ed25519.Sign(privateKey, []byte(message)))
}

func registerDeviceTestIdentity(t *testing.T, auth *authStore, publicKey string) authPrincipal {
	t.Helper()
	principal, _, code := auth.issueSession(sessionRequest{
		WorkspaceID: "demo", DisplayName: "Device", AccessType: accessTypeLogin,
		DeviceID: "dev_ed25519", PublicKey: publicKey,
	})
	if code != "" {
		t.Fatalf("register device: %s", code)
	}
	return principal
}

func TestDeviceEd25519RejectsPublicDigestForgery(t *testing.T) {
	auth := newTestAuth()
	publicKey, _ := newDeviceTestKey(t)
	original := registerDeviceTestIdentity(t, auth, publicKey)
	challenge, _ := auth.createDeviceChallenge("demo", original.DeviceID)
	// This is computable by anyone who can read the device's public key.
	digest := sha256.Sum256([]byte(publicKey + "\n" + challenge.Message))
	principal, _, code := auth.issueSession(sessionRequest{
		WorkspaceID: "demo", DisplayName: "Impostor", DeviceID: original.DeviceID,
		ChallengeID: challenge.ID, Signature: hex.EncodeToString(digest[:]),
	})
	if code != "DEVICE_CHALLENGE_FAILED" || principal.Token != "" {
		t.Fatalf("public digest must not authenticate: code=%q tokenIssued=%t", code, principal.Token != "")
	}
}

func TestDeviceEd25519ChallengeRejections(t *testing.T) {
	for _, scenario := range []string{
		"wrong private key", "request key substitution", "changed message", "expired", "workspace", "device",
		"revoked", "stored workspace", "invalid stored key", "missing stored key",
		"malformed signature", "short signature", "long signature", "padded signature", "newline signature",
	} {
		t.Run(scenario, func(t *testing.T) {
			auth := newTestAuth()
			publicKey, privateKey := newDeviceTestKey(t)
			otherPublicKey, otherPrivateKey := newDeviceTestKey(t)
			original := registerDeviceTestIdentity(t, auth, publicKey)
			challenge, _ := auth.createDeviceChallenge("demo", original.DeviceID)
			req := sessionRequest{
				WorkspaceID: "demo", DisplayName: "Again", DeviceID: original.DeviceID,
				ChallengeID: challenge.ID, Signature: signDeviceTestChallenge(privateKey, challenge.Message),
			}
			want := "DEVICE_CHALLENGE_FAILED"
			switch scenario {
			case "wrong private key":
				req.Signature = signDeviceTestChallenge(otherPrivateKey, challenge.Message)
			case "request key substitution":
				req.PublicKey = otherPublicKey
				req.Signature = signDeviceTestChallenge(otherPrivateKey, challenge.Message)
			case "changed message":
				req.Signature = signDeviceTestChallenge(privateKey, challenge.Message+"\n")
			case "expired":
				challenge.ExpiresAt = time.Now().UTC().Add(-time.Second)
			case "workspace":
				challenge.WorkspaceID = "other"
			case "device":
				challenge.DeviceID = "dev_other"
			case "revoked":
				auth.revokeDevice(original.DeviceID)
				want = "INVALID_REQUEST"
			case "stored workspace", "invalid stored key", "missing stored key":
				device := auth.devices[original.DeviceID]
				if scenario == "stored workspace" {
					device.WorkspaceID = "other"
					want = "INVALID_REQUEST"
				} else if scenario == "invalid stored key" {
					device.PublicKey = "legacy-invalid-key"
				} else {
					device.PublicKey = ""
				}
				auth.devices[original.DeviceID] = device
				req.PublicKey = publicKey
			case "malformed signature":
				req.Signature = "not a signature!"
			case "short signature":
				req.Signature = base64.RawURLEncoding.EncodeToString(make([]byte, 63))
			case "long signature":
				req.Signature = base64.RawURLEncoding.EncodeToString(make([]byte, 65))
			case "padded signature":
				req.Signature += "=="
			case "newline signature":
				req.Signature += "\n"
			}
			auth.challenges[challenge.ID] = challenge
			sessionCount, refreshCount := len(auth.sessions), len(auth.refreshTokens)
			principal, _, code := auth.issueSession(req)
			if code != want || principal.Token != "" {
				t.Fatalf("expected %s, got %q tokenIssued=%t", want, code, principal.Token != "")
			}
			if len(auth.sessions) != sessionCount || len(auth.refreshTokens) != refreshCount {
				t.Fatal("failed proof must not issue session or refresh tokens")
			}
		})
	}
}

func TestDeviceEd25519FailedProofConsumesChallenge(t *testing.T) {
	auth := newTestAuth()
	publicKey, privateKey := newDeviceTestKey(t)
	original := registerDeviceTestIdentity(t, auth, publicKey)
	challenge, _ := auth.createDeviceChallenge("demo", original.DeviceID)
	req := sessionRequest{DisplayName: "Again", DeviceID: original.DeviceID, ChallengeID: challenge.ID, Signature: "invalid"}
	if _, _, code := auth.issueSession(req); code != "DEVICE_CHALLENGE_FAILED" {
		t.Fatalf("invalid proof: %q", code)
	}
	req.Signature = signDeviceTestChallenge(privateKey, challenge.Message)
	if _, _, code := auth.issueSession(req); code != "DEVICE_CHALLENGE_FAILED" {
		t.Fatalf("consumed challenge must reject even a valid signature: %q", code)
	}
}

func TestDeviceEd25519LoginCannotReplaceRegisteredKey(t *testing.T) {
	for _, replacement := range []bool{false, true} {
		auth := newTestAuth()
		publicKey, privateKey := newDeviceTestKey(t)
		otherPublicKey, _ := newDeviceTestKey(t)
		original := registerDeviceTestIdentity(t, auth, publicKey)
		challenge, _ := auth.createDeviceChallenge("demo", original.DeviceID)
		req := sessionRequest{DisplayName: "Again", DeviceID: original.DeviceID, ChallengeID: challenge.ID,
			Signature: signDeviceTestChallenge(privateKey, challenge.Message)}
		if replacement {
			req.PublicKey = otherPublicKey
		}
		second, _, code := auth.issueSession(req)
		if code != "" || second.UserID != original.UserID {
			t.Fatalf("stored key proof must restore identity: code=%q sameUser=%t", code, second.UserID == original.UserID)
		}
		if auth.devices[original.DeviceID].PublicKey != publicKey {
			t.Fatal("login must not replace the registered public key")
		}
	}
}

func TestDeviceEd25519ChallengeConsumedAtomically(t *testing.T) {
	auth := newTestAuth()
	publicKey, privateKey := newDeviceTestKey(t)
	original := registerDeviceTestIdentity(t, auth, publicKey)
	challenge, _ := auth.createDeviceChallenge("demo", original.DeviceID)
	req := sessionRequest{DisplayName: "Again", DeviceID: original.DeviceID, ChallengeID: challenge.ID,
		Signature: signDeviceTestChallenge(privateKey, challenge.Message)}
	var wg sync.WaitGroup
	codes := make(chan string, 8)
	for i := 0; i < cap(codes); i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _, code := auth.issueSession(req)
			codes <- code
		}()
	}
	wg.Wait()
	close(codes)
	successes := 0
	for code := range codes {
		if code == "" {
			successes++
		} else if code != "DEVICE_CHALLENGE_FAILED" {
			t.Fatalf("unexpected login failure: %s", code)
		}
	}
	if successes != 1 {
		t.Fatalf("exactly one concurrent proof may succeed, got %d", successes)
	}
}

func TestDeviceRegistrationRejectsInvalidPublicKeys(t *testing.T) {
	publicKey, _ := newDeviceTestKey(t)
	for _, invalid := range []string{"not-a-key", publicKey + "=", publicKey[:10] + "\n" + publicKey[10:],
		base64.RawURLEncoding.EncodeToString(make([]byte, 31)), base64.RawURLEncoding.EncodeToString(make([]byte, 33))} {
		auth := newTestAuth()
		principal, _, code := auth.issueSession(sessionRequest{DisplayName: "New", DeviceID: "dev_new", PublicKey: invalid})
		if code != "INVALID_REQUEST" || principal.Token != "" || len(auth.devices) != 0 {
			t.Fatalf("invalid public key %q registered: code=%q", invalid, code)
		}
	}
}

func TestDeviceChallengeCreationReclaimsExpired(t *testing.T) {
	auth := newTestAuth()
	publicKey, privateKey := newDeviceTestKey(t)
	original := registerDeviceTestIdentity(t, auth, publicKey)
	live, code := auth.createDeviceChallenge("demo", original.DeviceID)
	if code != "" {
		t.Fatalf("create live challenge: %s", code)
	}
	// Fixed past timestamps exercise abandoned challenges without sleeps,
	// including other scopes and a malformed zero expiry.
	expired := []deviceChallenge{
		{ID: "expired_same_device", WorkspaceID: "demo", DeviceID: original.DeviceID, ExpiresAt: time.Unix(1, 0).UTC()},
		{ID: "expired_other_device", WorkspaceID: "demo", DeviceID: "dev_abandoned", ExpiresAt: time.Unix(2, 0).UTC()},
		{ID: "expired_other_workspace", WorkspaceID: "other", DeviceID: "dev_other", ExpiresAt: time.Unix(3, 0).UTC()},
		{ID: "expired_zero"},
	}
	auth.mu.Lock()
	for _, challenge := range expired {
		auth.challenges[challenge.ID] = challenge
	}
	auth.mu.Unlock()

	created, code := auth.createDeviceChallenge("demo", "dev_new")
	if code != "" {
		t.Fatalf("create challenge after expired entries: %s", code)
	}
	auth.mu.Lock()
	for _, challenge := range expired {
		if _, exists := auth.challenges[challenge.ID]; exists {
			t.Errorf("abandoned challenge %q was not reclaimed", challenge.ID)
		}
	}
	if len(auth.challenges) != 2 || auth.challenges[live.ID] != live || auth.challenges[created.ID] != created {
		t.Errorf("cleanup must retain the live and newly created challenges only, got %d entries", len(auth.challenges))
	}
	auth.mu.Unlock()
	principal, _, code := auth.issueSession(sessionRequest{DisplayName: "Again", DeviceID: original.DeviceID,
		ChallengeID: live.ID, Signature: signDeviceTestChallenge(privateKey, live.Message)})
	if code != "" || principal.UserID != original.UserID {
		t.Fatalf("cleanup must not invalidate a live proof: code=%q sameUser=%t", code, principal.UserID == original.UserID)
	}
}

func TestDeviceChallengeEndpointSupportsNewDevice(t *testing.T) {
	auth := newTestAuth()
	response := httptest.NewRecorder()
	handleSessionChallenge(auth, newRateLimiter(10, 1))(response,
		httptest.NewRequest(http.MethodPost, "/api/v1/sessions/challenge", strings.NewReader(`{"workspaceId":"demo","deviceId":"dev_new"}`)))
	if response.Code != http.StatusCreated {
		t.Fatalf("new devices can request a challenge: status=%d body=%s", response.Code, response.Body)
	}
	var challenge struct{ ChallengeID, DeviceID, Message string }
	if err := json.Unmarshal(response.Body.Bytes(), &challenge); err != nil {
		t.Fatal(err)
	}
	publicKey, privateKey := newDeviceTestKey(t)
	principal, _, code := auth.issueSession(sessionRequest{DisplayName: "New", DeviceID: challenge.DeviceID, PublicKey: publicKey,
		ChallengeID: challenge.ChallengeID, Signature: signDeviceTestChallenge(privateKey, challenge.Message)})
	if code != "" || principal.DeviceID != "dev_new" {
		t.Fatalf("signed new-device registration failed: %s", code)
	}
	if _, exists := auth.challenges[challenge.ChallengeID]; exists {
		t.Fatal("new-device proof must consume its challenge too")
	}
}
