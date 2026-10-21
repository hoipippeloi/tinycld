---
title: Help a member sign in
summary: For owners and admins — reset a member's two-step verification, give them a temporary password, or email them a reset link
tags: [admin, members, password, reset, mfa, two-step verification, locked out]
order: 29
---

When a member cannot sign in, an owner or admin can help from **Settings → Members**. Select the member, then use **Sign-in help**. It also shows whether the member has two-step verification on.

Only an owner can do this for another owner. You cannot use it on your own account: use **Settings → Security** for that.

Before you change anything, confirm who is asking. These are the actions a person with a stolen password would ask for.

## They lost their phone and recovery codes

Select **Reset two-step verification**, then **Reset**. This removes their authenticator app, passkeys and app passwords. They sign in with their password, and set up two-step verification again. If your organization requires it, the sign-in asks them to set it up before they continue.

## They forgot their password

You have two choices:

- **Email a reset link.** Select **Email a reset link**. The address is their recovery email; change it to another address they gave you if they cannot read that mailbox. The link lets whoever opens it choose a new password, and it expires in 30 minutes. The email also states their username, which they sign in with.
- **Set a temporary password.** Select **Set a temporary password**, type it twice and select **Set password**. Give it to them in person or by phone. At their next sign-in they must choose a new password before they continue.

Both end the member's other sessions and revoke their app passwords. A temporary password does not work in mail, calendar or file apps.

## They lost both

Reset their two-step verification first, then send a reset link or set a temporary password.

Every action is recorded in **Settings → Audit log**.
