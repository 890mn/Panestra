package security

import "testing"

func TestDeviceManagementPreservesIdentityAndChecksOwners(t *testing.T) {
	a := testAuth(t)
	_, pub := keypair(t)
	if _, err := a.addDevice("owner-device", "Owner", pub, "owner"); err != nil {
		t.Fatal(err)
	}
	if _, err := a.addDevice("tablet-device", "Tablet", pub, "operator"); err != nil {
		t.Fatal(err)
	}
	token, err := a.session("tablet-device")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := a.UpdateDevice("owner-device", "Host", "viewer"); err == nil {
		t.Fatal("demoted last owner")
	}
	for _, name := range []string{"", "\n", "hidden\nname"} {
		if _, err := a.UpdateDevice("tablet-device", name, "viewer"); err == nil {
			t.Fatal("invalid name accepted")
		}
	}
	if _, err := a.UpdateDevice("tablet-device", "Tablet", "root"); err == nil {
		t.Fatal("invalid role accepted")
	}
	d, err := a.UpdateDevice("tablet-device", "  我的平板  ", "viewer")
	if err != nil || d.Name != "我的平板" || d.PublicKey != "" {
		t.Fatalf("update: %+v %v", d, err)
	}
	current, err := a.Validate(token)
	if err != nil || current.Role != "viewer" || current.PublicKey != pub {
		t.Fatal("identity or session lost; role not updated")
	}
	if err := a.Revoke("tablet-device"); err != nil {
		t.Fatal(err)
	}
	if _, err := a.UpdateDevice("tablet-device", "Revived", "operator"); err == nil {
		t.Fatal("revoked device updated")
	}
}

func TestCloseWindowCancelsUnapprovedPairing(t *testing.T) {
	a := testAuth(t)
	key, pub := keypair(t)
	window := a.OpenWindow(true)
	challenge, err := a.Challenge("tablet-device", pub, "pair")
	if err != nil {
		t.Fatal(err)
	}
	pending, err := a.Pair(window.Code, "Tablet", challenge.ID, signature(key, challenge.Message), true)
	if err != nil {
		t.Fatal(err)
	}
	a.CloseWindow()
	if err := a.Approve(pending.ID, "operator", true); err == nil {
		t.Fatal("approved cancelled request")
	}
	status, err := a.Poll(pending.ID)
	if err != nil || status.Status != "denied" {
		t.Fatal("cancelled client was not informed")
	}
	challenge, err = a.Challenge("another-device", pub, "pair")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = a.Pair(window.Code, "Another", challenge.ID, signature(key, challenge.Message), true); err == nil {
		t.Fatal("closed code still accepted")
	}
}
