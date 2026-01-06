'use client'

import { useState } from "react"
import { createOrder } from "@/actions/checkout"
import { Button } from "@/components/ui/button"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { useI18n } from "@/lib/i18n/context"

export function BuyButton({ productId, disabled }: { productId: string, disabled?: boolean }) {
    const [loading, setLoading] = useState(false)
    const { t } = useI18n()

    const handleBuy = async () => {
        try {
            setLoading(true)
            const result = await createOrder(productId)

            if (!result?.success) {
                const message = result?.error ? t(result.error) : t('common.error')
                toast.error(message)
                setLoading(false)
                return
            }

            const { url, params } = result

            if (!params || !url) {
                toast.error(t('common.error'))
                setLoading(false)
                return
            }

            if (params) {
                // Submit Form
                const form = document.createElement('form')
                form.method = 'POST'
                form.action = url as string

                Object.entries(params as Record<string, any>).forEach(([k, v]) => {
                    const input = document.createElement('input')
                    input.type = 'hidden'
                    input.name = k
                    input.value = String(v)
                    form.appendChild(input)
                })

                document.body.appendChild(form)
                form.submit()
            }

        } catch (e: any) {
            toast.error(e.message || "Failed to create order")
            setLoading(false)
        }
    }

    return (
        <Button size="lg" className="w-full md:w-auto bg-foreground text-background hover:bg-foreground/90" onClick={handleBuy} disabled={disabled || loading}>
            {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {loading ? t('common.processing') : t('common.buyNow')}
        </Button>
    )
}
