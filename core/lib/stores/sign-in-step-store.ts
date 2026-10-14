import type { SignInStep } from '@tinycld/core/lib/sign-in-step'
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
