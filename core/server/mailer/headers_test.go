package mailer

import (
	"bufio"
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mrz1836/postmark"
)

// headers_test.go covers Message.Headers: every Sender writes them.

var ruleHeaders = map[string]string{
	"X-TinyCld-Loop": "widgets.test",
	"Auto-Submitted": "auto-generated",
}

func TestPostmarkSenderSend_WritesHeaders(t *testing.T) {
	var got postmark.Email
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&got)
		_ = json.NewEncoder(w).Encode(postmark.EmailResponse{MessageID: "pm-1"})
	}))
	t.Cleanup(srv.Close)
	withConfig(t, map[string]string{keyPostmarkAPIURL: srv.URL})

	err := NewPostmarkSender("tok", "", "noreply@widgets.test").Send(context.Background(), &Message{
		To: []Recipient{{Email: "a@widgets.test"}}, Subject: "hi", Text: "t", Headers: ruleHeaders,
	})
	if err != nil {
		t.Fatalf("Send: %v", err)
	}
	// Sorted by name, so the wire order does not depend on map order.
	want := []postmark.Header{
		{Name: "Auto-Submitted", Value: "auto-generated"},
		{Name: "X-TinyCld-Loop", Value: "widgets.test"},
	}
	if len(got.Headers) != len(want) || got.Headers[0] != want[0] || got.Headers[1] != want[1] {
		t.Fatalf("Headers = %v, want %v", got.Headers, want)
	}
	if got.From != "noreply@widgets.test" || got.Subject != "hi" || got.TextBody != "t" {
		t.Fatalf("email = %+v, want the default From, subject and text", got)
	}
}

func TestSMTPSenderSend_WritesHeaders(t *testing.T) {
	withConfig(t, map[string]string{})
	receiver := newFakeSMTPReceiver(t, smtpReceiverConfig{})
	defer receiver.close()
	swapMXLookup(t, map[string][]*net.MX{"example.org": {{Host: "127.0.0.1", Pref: 10}}})
	swapSMTPDial(t, receiver.dialOverride)

	err := NewSMTPSender(SMTPConfig{PublicHostname: "mx.tinycld.test"}).Send(context.Background(), &Message{
		From: "alice@tinycld.test", To: []Recipient{{Email: "bob@example.org"}},
		Subject: "Hello", Text: "hi", Headers: ruleHeaders,
	})
	if err != nil {
		t.Fatalf("Send: %v", err)
	}
	body := receiver.firstMessage(t).body
	for _, line := range []string{"Auto-Submitted: auto-generated\r\n", "X-Tinycld-Loop: widgets.test\r\n"} {
		if !strings.Contains(body, line) {
			t.Errorf("body missing %q; got: %s", line, body)
		}
	}
}

func TestLogSenderSend_WritesHeaders(t *testing.T) {
	path := filepath.Join(t.TempDir(), "emails.jsonl")
	t.Setenv("TINYCLD_EMAIL_LOG", path)

	if err := (&LogSender{}).Send(context.Background(), &Message{
		To: []Recipient{{Email: "a@widgets.test"}}, Subject: "hi", Headers: ruleHeaders,
	}); err != nil {
		t.Fatalf("Send: %v", err)
	}
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	if !scanner.Scan() {
		t.Fatal("email log is empty")
	}
	var entry loggedEmail
	if err := json.Unmarshal(scanner.Bytes(), &entry); err != nil {
		t.Fatal(err)
	}
	if len(entry.Headers) != 2 || entry.Headers["Auto-Submitted"] != "auto-generated" ||
		entry.Headers["X-TinyCld-Loop"] != "widgets.test" {
		t.Fatalf("logged headers = %v, want %v", entry.Headers, ruleHeaders)
	}
}

// A custom header must not replace a header the sender writes, or start a
// new header line. Every sender refuses it before anything is sent.
func TestSenders_RefuseUnsafeHeaders(t *testing.T) {
	withConfig(t, map[string]string{keyPostmarkAPIURL: "http://127.0.0.1:1"})
	swapMXLookup(t, map[string][]*net.MX{})
	senders := map[string]Sender{
		"postmark": NewPostmarkSender("tok", "", "noreply@widgets.test"),
		"smtp":     NewSMTPSender(SMTPConfig{PublicHostname: "mx.tinycld.test"}),
		"log":      &LogSender{},
	}
	unsafe := map[string]map[string]string{
		"From":                {"From": "evil@widgets.test"},
		"subject (any case)":  {"subject": "other"},
		"Message-ID":          {"Message-ID": "<x@widgets.test>"},
		"Date":                {"Date": "Mon, 1 Jan 2024 00:00:00 +0000"},
		"MIME-Version":        {"Mime-Version": "1.0"},
		"Content-Type":        {"Content-Type": "text/html"},
		"Content-* (any)":     {"content-transfer-encoding": "base64"},
		"Bcc":                 {"BCC": "spy@widgets.test"},
		"CR in a value":       {"X-Note": "a\rBcc: spy@widgets.test"},
		"LF in a value":       {"X-Note": "a\nBcc: spy@widgets.test"},
		"LF in a name":        {"X-Note\nBcc": "spy@widgets.test"},
		"colon in a name":     {"X-Note:": "a"},
		"space in a name":     {"X Note": "a"},
		"non-ASCII in a name": {"X-Nöte": "a"},
		"empty name":          {"": "a"},
	}
	for senderName, sender := range senders {
		for caseName, headers := range unsafe {
			t.Run(senderName+"/"+caseName, func(t *testing.T) {
				err := sender.Send(context.Background(), &Message{
					From: "alice@widgets.test", To: []Recipient{{Email: "bob@example.org"}},
					Subject: "hi", Text: "t", Headers: headers,
				})
				// The provider is unreachable, so only the header check can
				// give an error that names the header.
				if err == nil || !strings.Contains(err.Error(), "header") {
					t.Fatalf("headers %q: err = %v, want a header refusal", headers, err)
				}
			})
		}
	}
}
