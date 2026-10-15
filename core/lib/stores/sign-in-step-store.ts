import { type SignInStep, signInStepFromError } from '@tinycld/core/lib/sign-in-step'
import { create } from '@tinycld/core/lib/store'

/**
 * The second sign-in step the server asked for, if any. A store rather than
 * login-form state because more than one path can start a sign-in that ends
 * here (the login form, accepting an invite, changing a password), and the
 * login overlay renders the step whichever path set it. Not persisted: the
 * step token expires in minutes.
 */
interface SignInStepStoreState {
    step: SignInStep | null
    setStep: (step: SignInStep) => void
    clear: () => void
}

export const useSignInStepStore = create<SignInStepStoreState>()(set => ({
    step: null,
    setStep: step => set({ step }),
    clear: () => set({ step: null }),
}))

/**
 * Moves the sign-in to the next step when a step route (a code, a passkey, an
 * enrollment) answers with another step instead of a session: for example
 * the "choose a new password" step after the code. Returns false for any
 * other error, which the caller shows.
 */
export function advanceSignInStep(error: unknown): boolean {
    const step = signInStepFromError(error)
    if (!step) return false
    useSignInStepStore.getState().setStep(step)
    return true
}
