import { useQuery } from '@tanstack/react-query'
import type { FormHostUi } from '@tinycld/core/lib/forms/host-ui'
import type { FormHost } from '@tinycld/core/lib/packages/derive-form-hosts'

/** The host's lazy UI module. React Query caches the promise, so every field shares one load. */
export function useHostUi(host: FormHost | undefined): FormHostUi | null {
    const { data } = useQuery({
        queryKey: ['forms', 'host-ui', host?.key],
        queryFn: () => (host ? host.ui() : Promise.resolve(null)),
        enabled: Boolean(host),
        staleTime: Number.POSITIVE_INFINITY,
    })
    return data ?? null
}
