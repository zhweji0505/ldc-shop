import { notFound } from "next/navigation"
import { db } from "@/lib/db"
import { products, cards } from "@/lib/db/schema"
import { eq, sql } from "drizzle-orm"
import { auth } from "@/lib/auth"
import { BuyContent } from "@/components/buy-content"
import { getProductReviews, getProductRating, canUserReview, cancelExpiredOrders } from "@/lib/db/queries"

export const dynamic = 'force-dynamic'

interface BuyPageProps {
    params: Promise<{ id: string }>
}

export default async function BuyPage({ params }: BuyPageProps) {
    const { id } = await params
    const session = await auth()

    try {
        await cancelExpiredOrders({ productId: id })
    } catch {
        // Best effort cleanup
    }

    // Get product with error handling for missing tables/columns
    let result: any[] = [];
    try {
        result = await db
            .select({
                id: products.id,
                name: products.name,
                description: products.description,
                price: products.price,
                image: products.image,
                category: products.category,
                isActive: products.isActive,
                purchaseLimit: products.purchaseLimit,
            })
            .from(products)
            .where(eq(products.id, id))
            .limit(1)
    } catch (error: any) {
        const errorString = JSON.stringify(error);
        const isTableOrColumnMissing =
            error.message?.includes('does not exist') ||
            error.cause?.message?.includes('does not exist') ||
            errorString.includes('42P01') || // undefined_table
            errorString.includes('42703') || // undefined_column
            (errorString.includes('relation') && errorString.includes('does not exist'));

        if (isTableOrColumnMissing) {
            console.log("Database initialized check: Table/Column missing in Buy Page. Running inline migrations...");
            const { sql } = await import("drizzle-orm");

            await db.execute(sql`
                -- Same SQL as in page.tsx
                CREATE TABLE IF NOT EXISTS products (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    description TEXT,
                    price DECIMAL(10, 2) NOT NULL,
                    category TEXT,
                    image TEXT,
                    is_active BOOLEAN DEFAULT TRUE,
                    sort_order INTEGER DEFAULT 0,
                    purchase_limit INTEGER,
                    created_at TIMESTAMP DEFAULT NOW()
                );
                CREATE TABLE IF NOT EXISTS cards (
                    id SERIAL PRIMARY KEY,
                    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
                    card_key TEXT NOT NULL,
                    is_used BOOLEAN DEFAULT FALSE,
                    reserved_order_id TEXT,
                    reserved_at TIMESTAMP,
                    used_at TIMESTAMP,
                    created_at TIMESTAMP DEFAULT NOW()
                );
                CREATE TABLE IF NOT EXISTS orders (
                    order_id TEXT PRIMARY KEY,
                    product_id TEXT NOT NULL,
                    product_name TEXT NOT NULL,
                    amount DECIMAL(10, 2) NOT NULL,
                    email TEXT,
                    status TEXT DEFAULT 'pending',
                    trade_no TEXT,
                    card_key TEXT,
                    paid_at TIMESTAMP,
                    delivered_at TIMESTAMP,
                    user_id TEXT,
                    username TEXT,
                    created_at TIMESTAMP DEFAULT NOW()
                );
                CREATE TABLE IF NOT EXISTS login_users (
                    user_id TEXT PRIMARY KEY,
                    username TEXT,
                    created_at TIMESTAMP DEFAULT NOW(),
                    last_login_at TIMESTAMP DEFAULT NOW()
                );
                ALTER TABLE products ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
                ALTER TABLE products ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0;
                ALTER TABLE products ADD COLUMN IF NOT EXISTS purchase_limit INTEGER;
                ALTER TABLE cards ADD COLUMN IF NOT EXISTS reserved_order_id TEXT;
                ALTER TABLE cards ADD COLUMN IF NOT EXISTS reserved_at TIMESTAMP;
                CREATE TABLE IF NOT EXISTS settings (
                    key TEXT PRIMARY KEY,
                    value TEXT,
                    updated_at TIMESTAMP DEFAULT NOW()
                );
                CREATE TABLE IF NOT EXISTS reviews (
                    id SERIAL PRIMARY KEY,
                    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
                    order_id TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    username TEXT NOT NULL,
                    rating INTEGER NOT NULL,
                    comment TEXT,
                    created_at TIMESTAMP DEFAULT NOW()
                );
            `);

            // Retry query
            result = await db
                .select({
                    id: products.id,
                    name: products.name,
                    description: products.description,
                    price: products.price,
                    image: products.image,
                    category: products.category,
                    isActive: products.isActive,
                    purchaseLimit: products.purchaseLimit,
                })
                .from(products)
                .where(eq(products.id, id))
                .limit(1)
        } else {
            throw error;
        }
    }

    const product = result[0]

    // Return 404 if product doesn't exist or is inactive
    if (!product || product.isActive === false) {
        notFound()
    }

    // Get stock count (exclude reserved cards)
    let stockCount = 0
    try {
        const stockResult = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(cards)
            .where(sql`${cards.productId} = ${id} AND ${cards.isUsed} = false AND (${cards.reservedAt} IS NULL OR ${cards.reservedAt} < NOW() - INTERVAL '1 minute')`)

        stockCount = stockResult[0]?.count || 0
    } catch (error: any) {
        const errorString = JSON.stringify(error)
        const isTableOrColumnMissing =
            error.message?.includes('does not exist') ||
            error.cause?.message?.includes('does not exist') ||
            errorString.includes('42P01') || // undefined_table
            errorString.includes('42703') || // undefined_column
            (errorString.includes('relation') && errorString.includes('does not exist'))

        if (!isTableOrColumnMissing) throw error

        await db.execute(sql`
            CREATE TABLE IF NOT EXISTS cards (
                id SERIAL PRIMARY KEY,
                product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
                card_key TEXT NOT NULL,
                is_used BOOLEAN DEFAULT FALSE,
                reserved_order_id TEXT,
                reserved_at TIMESTAMP,
                used_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT NOW()
            );
            ALTER TABLE cards ADD COLUMN IF NOT EXISTS reserved_order_id TEXT;
            ALTER TABLE cards ADD COLUMN IF NOT EXISTS reserved_at TIMESTAMP;
        `)

        const stockResult = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(cards)
            .where(sql`${cards.productId} = ${id} AND ${cards.isUsed} = false AND (${cards.reservedAt} IS NULL OR ${cards.reservedAt} < NOW() - INTERVAL '1 minute')`)

        stockCount = stockResult[0]?.count || 0
    }

    // Get reviews (with error handling for new databases)
    let reviews: any[] = []
    let rating = { average: 0, count: 0 }
    let userCanReview: { canReview: boolean; orderId?: string } = { canReview: false }

    try {
        reviews = await getProductReviews(id)
        rating = await getProductRating(id)
    } catch (e) {
        // Reviews table might not exist yet
        console.log('Reviews fetch error:', e)
    }

    // Check review eligibility separately so it runs even if reviews table doesn't exist
    if (session?.user?.id) {
        try {
            userCanReview = await canUserReview(session.user.id, id, session.user.username || undefined)
        } catch (e) {
            console.log('canUserReview error:', e)
        }
    }

    return (
        <BuyContent
            product={product}
            stockCount={stockCount}
            isLoggedIn={!!session?.user}
            reviews={reviews}
            averageRating={rating.average}
            reviewCount={rating.count}
            canReview={userCanReview.canReview}
            reviewOrderId={userCanReview.orderId}
        />
    )
}
