'use client'

import Link from "next/link"
import { useI18n } from "@/lib/i18n/context"
import { DropdownMenuItem } from "@/components/ui/dropdown-menu"
import { LanguageSwitcher } from "@/components/language-switcher"
import { ShoppingBag } from "lucide-react"
import { Input } from "@/components/ui/input"
import { usePathname, useRouter } from "next/navigation"
import { useCallback, useEffect, useState } from "react"
import { cn } from "@/lib/utils"
import { getMyUnreadCount } from "@/actions/user-notifications"

export function HeaderLogo({ adminName, shopNameOverride, shopLogoOverride }: { adminName?: string; shopNameOverride?: string | null; shopLogoOverride?: string | null }) {
    const { t } = useI18n()
    const override = shopNameOverride?.trim()
    const logoUrl = shopLogoOverride?.trim()
    const shopName = adminName
        ? t('common.shopNamePattern', { name: adminName, appName: t('common.appName') })
        : t('common.appName')

    return (
        <Link href="/" className="flex items-center gap-2 min-w-0 group text-muted-foreground hover:text-primary transition-colors duration-200 hover:-translate-y-0.5">
            {logoUrl ? (
                <img src={logoUrl} alt="Logo" className="h-8 w-8 rounded-lg object-contain" />
            ) : (
                <div className="h-8 w-8 rounded-lg bg-foreground flex items-center justify-center transition-all duration-300 shadow-sm group-hover:shadow-md">
                    <ShoppingBag className="h-4 w-4 text-background" />
                </div>
            )}
            <span className="text-xs sm:text-sm font-semibold tracking-tight truncate max-w-[160px] sm:max-w-[220px] md:max-w-none">
                {override || shopName}
            </span>
        </Link>
    )
}

export function HeaderNav({ isAdmin, isLoggedIn }: { isAdmin: boolean; isLoggedIn: boolean }) {
    const { t } = useI18n()
    const isZh = t('common.myOrders').includes('订单')

    return (
        <div className="hidden md:flex items-center gap-6">
            <Link
                href="/nav"
                className="flex items-center text-sm font-medium text-muted-foreground hover:text-primary transition-colors duration-200 hover:-translate-y-0.5"
            >
                {t('common.navigator')}
            </Link>
            {isLoggedIn && (
                <>
                    <Link
                        href="/profile"
                        className="flex items-center text-sm font-medium text-muted-foreground hover:text-primary transition-colors duration-200 hover:-translate-y-0.5"
                    >
                        {isZh ? "个人中心" : "Profile"}
                    </Link>
                </>
            )}
            {isAdmin && (
                <Link
                    href="/admin/settings"
                    className="flex items-center text-sm font-medium text-muted-foreground hover:text-primary transition-colors duration-200 hover:-translate-y-0.5"
                >
                    {t('common.admin')}
                </Link>
            )}
        </div>
    )
}

export function HeaderSearch({ className }: { className?: string }) {
    const { t } = useI18n()
    const router = useRouter()
    const [q, setQ] = useState("")

    return (
        <form
            className={cn("w-full", className)}
            onSubmit={(e) => {
                e.preventDefault()
                const query = q.trim()
                if (!query) return
                router.push(`/search?q=${encodeURIComponent(query)}`)
            }}
        >
            <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={t('search.placeholder')}
            />
        </form>
    )
}

export function HeaderUserMenuItems({ isAdmin }: { isAdmin: boolean }) {
    const { t } = useI18n()

    return (
        <>
            <DropdownMenuItem asChild>
                <Link href="/nav">{t('common.navigator')}</Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
                <Link href="/profile" className="flex w-full items-center justify-between gap-2">
                    <span>{t('common.myOrders').includes('订单') ? "个人中心" : "Profile"}</span>
                    <HeaderUnreadBadge className="ml-2" />
                </Link>
            </DropdownMenuItem>
            {isAdmin && (
                <DropdownMenuItem asChild>
                    <Link href="/admin/settings">{t('common.admin')}</Link>
                </DropdownMenuItem>
            )}
        </>
    )
}

export { LanguageSwitcher }

export function HeaderUnreadBadge({ initialCount = 0, className }: { initialCount?: number; className?: string }) {
    const [count, setCount] = useState(initialCount)
    const pathname = usePathname()

    const refresh = useCallback(async () => {
        try {
            const res = await getMyUnreadCount()
            if (res?.success) {
                setCount(res.count || 0)
            }
        } catch {
            // ignore
        }
    }, [])

    useEffect(() => {
        refresh()
    }, [pathname, refresh])

    useEffect(() => {
        const handler = () => {
            void refresh()
        }
        if (typeof window !== "undefined") {
            window.addEventListener("ldc:notifications-updated", handler)
        }
        return () => {
            if (typeof window !== "undefined") {
                window.removeEventListener("ldc:notifications-updated", handler)
            }
        }
    }, [refresh])

    if (!count) return null

    return (
        <span className={cn("inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-medium text-white", className)}>
            {count > 99 ? "99+" : count}
        </span>
    )
}
