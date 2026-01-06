'use server'

import { auth } from '@/lib/auth'
import { createReview } from '@/lib/db/queries'
import { db } from '@/lib/db'
import { sql } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'

export async function submitReview(
    productId: string,
    orderId: string,
    rating: number,
    comment: string
): Promise<{ success: boolean; error?: string }> {
    try {
        const session = await auth()
        if (!session?.user) {
            return { success: false, error: 'Not authenticated' }
        }

        // Validate rating
        if (rating < 1 || rating > 5) {
            return { success: false, error: 'Invalid rating' }
        }

        // Ensure reviews table exists
        await db.execute(sql`
            CREATE TABLE IF NOT EXISTS reviews (
                id SERIAL PRIMARY KEY,
                product_id TEXT NOT NULL,
                order_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                username TEXT NOT NULL,
                rating INTEGER NOT NULL,
                comment TEXT,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `)

        // Check if already reviewed (now table definitely exists)
        const existingReview = await db.execute(sql`
            SELECT id FROM reviews WHERE order_id = ${orderId} LIMIT 1
        `)
        if (existingReview.rows && existingReview.rows.length > 0) {
            return { success: false, error: 'Already reviewed' }
        }

        // Create review
        await createReview({
            productId,
            orderId,
            userId: session.user.id || '',
            username: session.user.username || session.user.name || 'Anonymous',
            rating,
            comment: comment || undefined
        })

        revalidatePath(`/buy/${productId}`)
        revalidatePath(`/order/${orderId}`)

        return { success: true }
    } catch (error) {
        console.error('Failed to submit review:', error)
        return { success: false, error: 'Failed to submit review' }
    }
}
