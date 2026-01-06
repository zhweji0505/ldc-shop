import { getSetting } from "@/lib/db/queries"
import { AnnouncementForm } from "@/components/admin/announcement-form"

export default async function AnnouncementPage() {
    let announcement: string | null = null
    try {
        announcement = await getSetting('announcement')
    } catch {
        // Settings table might not exist yet, will be created on first save
    }

    return (
        <div className="space-y-6">
            <AnnouncementForm initialContent={announcement} />
        </div>
    )
}
