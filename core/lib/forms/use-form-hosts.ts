import { tinycldConfig } from '@tinycld/app-generated/tinycld-config'
import { deriveFormHosts, type FormHost } from '../packages/derive-form-hosts'

export type { FormHost }

/** Hosts from the installed packages. Static for the life of the app, like the package registry. */
export const packageFormHosts: FormHost[] = deriveFormHosts(tinycldConfig)

export function useFormHosts(): FormHost[] {
    return packageFormHosts
}

export function useFormHost(key: string | undefined): FormHost | undefined {
    return packageFormHosts.find(h => h.key === key)
}
