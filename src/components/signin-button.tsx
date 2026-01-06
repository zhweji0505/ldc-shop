"use client"

import { signIn } from "next-auth/react"
import { Button } from "@/components/ui/button"
import { useI18n } from "@/lib/i18n/context"

export function SignInButton() {
    const { t } = useI18n()

    return (
        <Button
            size="sm"
            className="bg-foreground text-background hover:bg-foreground/90"
            onClick={() => signIn("linuxdo")}
        >
            {t('common.login')}
        </Button>
    )
}
