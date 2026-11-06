//go:build windows

package main

import (
	"io"
	"testing"
	"unsafe"

	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
)

const systemMandatoryLabelACEType = 0x11

// The pipe Docker clients use: only this user and SYSTEM may open it (anyone else could use
// Docker through it as this user), and when elevated, only elevated programs may write to it.
func TestPipeIsOnlyThisUsersAndSystems(t *testing.T) {
	path := localPath(t, "acl")
	l, err := listenLocal(path)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	go func() {
		c, err := l.Accept()
		if err == nil {
			_, _ = io.Copy(io.Discard, c)
			c.Close()
		}
	}()
	c, err := winio.DialPipe(path, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	handle := windows.Handle(c.(interface{ Fd() uintptr }).Fd())
	sd, err := windows.GetSecurityInfo(handle, windows.SE_KERNEL_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.LABEL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("security descriptor: %s", sd)

	control, _, err := sd.Control()
	if err != nil {
		t.Fatal(err)
	}
	if control&windows.SE_DACL_PROTECTED == 0 {
		t.Error("the DACL inherits entries; it should be exactly its own")
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]bool{"S-1-5-18": true, user.User.Sid.String(): true}
	dacl, _, err := sd.DACL()
	if err != nil || dacl == nil {
		t.Fatalf("no DACL: %v", err)
	}
	got := map[string]bool{}
	for i := uint32(0); i < uint32(dacl.AceCount); i++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(dacl, i, &ace); err != nil {
			t.Fatal(err)
		}
		sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart)).String()
		if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE || !want[sid] {
			t.Errorf("unexpected entry: type %d for %s", ace.Header.AceType, sid)
		}
		got[sid] = true
	}
	if len(got) != len(want) || int(dacl.AceCount) != len(want) {
		t.Errorf("DACL entries for %v, want exactly %v", got, want)
	}

	elevated := windows.GetCurrentProcessToken().IsElevated()
	sacl, _, err := sd.SACL()
	high := false
	if err == nil && sacl != nil {
		for i := uint32(0); i < uint32(sacl.AceCount); i++ {
			var ace *windows.ACCESS_ALLOWED_ACE
			if err := windows.GetAce(sacl, i, &ace); err != nil {
				t.Fatal(err)
			}
			sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart)).String()
			// S-1-16-12288 is High integrity; 1 is SYSTEM_MANDATORY_LABEL_NO_WRITE_UP.
			if ace.Header.AceType == systemMandatoryLabelACEType && sid == "S-1-16-12288" && ace.Mask&1 != 0 {
				high = true
			}
		}
	}
	if high != elevated {
		t.Errorf("high integrity label: %v, but elevated: %v", high, elevated)
	}
}
