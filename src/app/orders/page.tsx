import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import { orders } from "@/lib/db/schema"
import { eq, desc } from "drizzle-orm"
import { redirect } from "next/navigation"
import { OrdersContent } from "@/components/orders-content"
import { cancelExpiredOrders } from "@/lib/db/queries"

export const dynamic = 'force-dynamic';

export default async function OrdersPage() {
    const session = await auth()
    if (!session?.user) redirect('/api/auth/signin')

    try {
        await cancelExpiredOrders({ userId: session.user.id || undefined })
    } catch {
        // Best effort cleanup
    }

    const userOrders = await db.query.orders.findMany({
        where: eq(orders.userId, session.user.id || ''),
        orderBy: [desc(orders.createdAt)]
    })

    return (
        <OrdersContent
            orders={userOrders.map(o => ({
                orderId: o.orderId,
                productName: o.productName,
                amount: o.amount,
                status: o.status,
                createdAt: o.createdAt
            }))}
        />
    )
}
