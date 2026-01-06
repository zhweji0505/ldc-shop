'use server'

import { setSetting, getSetting } from "@/lib/db/queries"
import { revalidatePath } from "next/cache"
import { db } from "@/lib/db"
import { sql } from "drizzle-orm"

export async function saveAnnouncement(content: string) {
    try {
        await setSetting('announcement', content)
    } catch (error: any) {
        // If settings table doesn't exist, create it
        if (error.message?.includes('does not exist') ||
            error.code === '42P01' ||
            JSON.stringify(error).includes('42P01')) {
            await db.execute(sql`
                CREATE TABLE IF NOT EXISTS settings (
                    key TEXT PRIMARY KEY,
                    value TEXT,
                    updated_at TIMESTAMP DEFAULT NOW()
                )
            `)
            // Retry the insert
            await setSetting('announcement', content)
        } else {
            throw error
        }
    }
    revalidatePath('/')
    return { success: true }
}

export async function getAnnouncement() {
    try {
        return await getSetting('announcement')
    } catch {
        return null
    }
}
