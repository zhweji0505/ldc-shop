"use server"

import { auth } from "@/lib/auth"
import { getUserNotifications, getUserUnreadNotificationCount, markAllUserNotificationsRead, markUserNotificationRead } from "@/lib/db/queries"

export async function markAllNotificationsRead() {
    const session = await auth()
    const userId = session?.user?.id
    if (!userId) {
        return { success: false, error: "Unauthorized" }
    }

    await markAllUserNotificationsRead(userId)
    return { success: true }
}

export async function getMyNotifications() {
    const session = await auth()
    const userId = session?.user?.id
    if (!userId) {
        return { success: false, error: "Unauthorized" }
    }

    const rows = await getUserNotifications(userId, 20)
    const items = rows.map((n) => ({
        id: n.id,
        type: n.type,
        titleKey: n.titleKey,
        contentKey: n.contentKey,
        data: n.data,
        isRead: n.isRead,
        createdAt: n.createdAt ? new Date(n.createdAt as any).getTime() : null
    }))
    return { success: true, items }
}

export async function getMyUnreadCount() {
    const session = await auth()
    const userId = session?.user?.id
    if (!userId) {
        return { success: false, error: "Unauthorized" }
    }

    const count = await getUserUnreadNotificationCount(userId)
    return { success: true, count }
}

export async function markNotificationRead(id: number) {
    const session = await auth()
    const userId = session?.user?.id
    if (!userId) {
        return { success: false, error: "Unauthorized" }
    }

    await markUserNotificationRead(userId, id)
    return { success: true }
}
