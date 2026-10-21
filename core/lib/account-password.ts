import { captureException } from '@tinycld/core/lib/errors'
import { pb } from '@tinycld/core/lib/pocketbase'
import { signInStepFromError } from '@tinycld/core/lib/sign-in-step'
import { useSignInStepStore } from '@tinycld/core/lib/stores/sign-in-step-store'

interface ChangePasswordArgs {
    oldPassword: string
    newPassword: string
    passwordConfirm: string
}

// Changing a password is a PocketBase auth-record operation: oldPassword /
// password / passwordConfirm are write-only auth params (not schema fields) and
// PB rotates the session token on success. The pbtsdb store can't carry this —
// it would optimistically write the cleartext password into the local record —
// so this is the documented per-site exception to the raw-PB-access rule. The
// server-side users field guard (users_guard.go) explicitly allows a self
// `password` change; PB's own form validation enforces oldPassword correctness.
export async function changeMyPassword(args: ChangePasswordArgs): Promise<void> {
    const record = pb.authStore.record
    if (!record) throw new Error('Not authenticated')
    const userId = record.id
    // The username, not the account email: the email is not a sign-in name.
    const username: string = record.username

    await pb.collection('users').update(userId, {
        oldPassword: args.oldPassword,
        password: args.newPassword,
        passwordConfirm: args.passwordConfirm,
    })

    // PB invalidates the current token on a password change, so re-auth right
    // after to keep the session alive instead of forcing the user to sign in.
    // With MFA on, the re-auth stops at the second step. The old session is
    // already dead, so drop it: the login overlay then opens on the code step.
    try {
        await pb.collection('users').authWithPassword(username, args.newPassword)
    } catch (err) {
        const step = signInStepFromError(err)
        if (step) {
            useSignInStepStore.getState().setStep(step)
            pb.authStore.clear()
            return
        }
        captureException('account.changePassword.reauth', err)
        throw err
    }
}

// An owner or admin gives a member who lost their password a temporary one.
// The same per-site exception as changeMyPassword: pbtsdb would write the
// cleartext password into the local record. users.manageRule waives
// `oldPassword` for an admin, and the server's users guard marks the password
// temporary (must_change_password), refuses it for an owner unless the caller
// is an owner, ends the member's sessions and revokes their app passwords.
export async function setTemporaryPassword(userId: string, password: string): Promise<void> {
    await pb.collection('users').update(userId, { password, passwordConfirm: password })
}

/**
 * Request a password-reset email for the given address. Uses PocketBase's
 * built-in flow (PB mints the token and owns its lifecycle); the outbound email
 * is overridden server-side to send via the core mailer with a link to the
 * app's own /reset-password/<token> screen.
 *
 * Failures are reported but NOT rethrown: the login UI always shows the same
 * "if an account exists, we've sent a link" confirmation so the response can't
 * be used to discover whether an email is registered.
 */
export async function requestPasswordReset(email: string): Promise<void> {
    try {
        await pb.collection('users').requestPasswordReset(email)
    } catch (err) {
        captureException('account.requestPasswordReset', err)
    }
}

/**
 * Complete a password reset using the token from the emailed link. Errors here
 * (invalid/expired token, weak password) ARE surfaced so the confirm screen can
 * show them to the user.
 */
export async function confirmPasswordReset(
    token: string,
    password: string,
    passwordConfirm: string
): Promise<void> {
    await pb.collection('users').confirmPasswordReset(token, password, passwordConfirm)
}
