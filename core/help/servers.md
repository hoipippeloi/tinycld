---
title: Servers on your device
summary: Adding more than one server to the app and switching between them
tags: [servers, switch, connect, mobile, sign in]
order: 22
---

## One app, several servers

The app can hold several servers at once — a work server and a home one, or two
organizations you belong to. Each keeps its **own account, its own data, and its
own sign-in**. Switching between them doesn't sign you out of any of the others.

In a web browser each server opens at its own address, and you sign in to each one
separately. The browser keeps a list of servers too — see **In a web
browser** below.

## Adding a server

Open the **More** menu (the ⋯ tab at the bottom on a phone) and choose **Add
server** under **Servers**. Type the address and tap **Connect**. You can also go
to **Settings → This device → Servers** and select **Add server**.

You can type just the hostname — `acme.tinycld.org` is enough, and the app fills
in the rest. If you host your own server, use the full address you'd type in a
browser.

Adding a server doesn't disturb the one you're already on. You'll sign in to the
new server, and both stay signed in from then on.

## Switching

The **Servers** section of the **More** menu lists every server you've added,
with a check beside the one you're on. Tap another to switch to it. On a tablet
the same list is in the user menu, at the bottom of the nav rail.

**The app restarts when you switch.** That's expected and takes a second or two:
each server can run a different set of packages, so the app reloads to match the
one you're moving to. You won't be asked to sign in again — that server remembers
you.

Switching back is just as quick. Nothing is re-downloaded and nothing is
re-entered.

## Removing a server

On a tablet or in a web browser, open the user menu and choose **Remove server**,
then the server to remove. You can also go to **Settings → This device → Servers**
and use the trash icon beside a server. Removing signs you out of that server on this device and forgets its
address; your account on the server itself is untouched, and you can add it again
later.

If you remove the server you're currently using, the app switches to another one
you've saved. Remove the last one and you'll be asked to connect somewhere.

Removing always asks you to confirm, so a mis-tap does not remove the server you
meant to switch to.

## In a web browser

A browser cannot share one sign-in between two addresses, so switching in a
browser opens the other server in the same tab. If you are not signed in there
yet, you sign in once.

To add a server, go to **Settings → This device → Servers**, select **Add
server**, and type its address. The browser opens that server. When you switch
from one server to another, the server you arrive on adds the one you came from
to its list. After that, the user menu on each server shows the other.

Removing a server in a browser only removes it from the list. It does not sign
you out of that server.

## Disconnecting from this server

To sign out of the server you're using now and forget it, go to **Settings →
This device → Servers** and select **Disconnect**. This works in a web browser
too. Your account on the server is not deleted, and any other servers you've
added stay signed in.
