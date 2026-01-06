'use client'

import { useState, useMemo } from "react"
import { useI18n } from "@/lib/i18n/context"
import Link from "next/link"
import { Card, CardContent, CardFooter } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { StarRating } from "@/components/star-rating"
import ReactMarkdown from 'react-markdown'
import { cn } from "@/lib/utils"

interface Product {
    id: string
    name: string
    description: string | null
    price: string
    image: string | null
    category: string | null
    stockCount: number
    soldCount: number
    rating?: number
    reviewCount?: number
}

interface HomeContentProps {
    products: Product[]
    announcement?: string | null
    visitorCount?: number
}

export function HomeContent({ products, announcement, visitorCount }: HomeContentProps) {
    const { t } = useI18n()
    const [selectedCategory, setSelectedCategory] = useState<string | null>(null)
    const [searchTerm, setSearchTerm] = useState("")

    // Extract unique categories
    const categories = useMemo(() => {
        const uniqueCategories = new Set(products.map(p => p.category).filter(Boolean) as string[])
        return Array.from(uniqueCategories).sort()
    }, [products])

    // Filter products
    const filteredProducts = useMemo(() => {
        let result = products

        // Category filter
        if (selectedCategory) {
            result = result.filter(p => p.category === selectedCategory)
        }

        // Search filter
        if (searchTerm) {
            const lowerTerm = searchTerm.toLowerCase()
            result = result.filter(p =>
                p.name.toLowerCase().includes(lowerTerm) ||
                (p.description && p.description.toLowerCase().includes(lowerTerm))
            )
        }

        return result
    }, [products, selectedCategory, searchTerm])

    return (
        <main className="container py-8 md:py-16">

            {/* Announcement Banner */}
            {announcement && (
                <section className="mb-8">
                    <div className="relative overflow-hidden rounded-xl border border-primary/20 bg-gradient-to-r from-primary/5 via-primary/10 to-primary/5 p-4">
                        <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-primary to-primary/50" />
                        <div className="flex items-start gap-3 pl-3">
                            <svg className="w-5 h-5 text-primary shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z" />
                            </svg>
                            <p className="text-sm text-foreground/90 leading-relaxed whitespace-pre-wrap">{announcement}</p>
                        </div>
                    </div>
                </section>
            )}

            {typeof visitorCount === 'number' && (
                <div className="mb-6 flex items-center">
                    <Badge variant="secondary">
                        {t('home.visitorCount', { count: visitorCount })}
                    </Badge>
                </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">
                {/* Sidebar / Topbar for Categories */}
                <aside className="lg:col-span-1">
                    <div className="sticky top-24 space-y-6">
                        {/* Search Input */}
                        <div className="relative">
                            <svg
                                xmlns="http://www.w3.org/2000/svg"
                                className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                            >
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                            </svg>
                            <Input
                                placeholder={t('common.searchPlaceholder')}
                                value={searchTerm}
                                onChange={(e) => setSearchTerm(e.target.value)}
                                className="pl-9 bg-muted/50 border-muted-foreground/20 focus:bg-background transition-colors"
                            />
                        </div>

                        <div className="space-y-4">
                            <h2 className="text-lg font-semibold tracking-tight px-1 flex items-center gap-2">
                                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-primary">
                                    <path d="M3 6h18" />
                                    <path d="M7 12h10" />
                                    <path d="M10 18h4" />
                                </svg>
                                {t('common.categories')}
                            </h2>
                            <div className="flex flex-row lg:flex-col gap-2 overflow-x-auto pb-4 lg:pb-0 no-scrollbar">
                                <Button
                                    variant={selectedCategory === null ? "default" : "ghost"}
                                    className={cn(
                                        "justify-start whitespace-nowrap",
                                        selectedCategory === null ? "bg-primary text-primary-foreground shadow-lg shadow-primary/20" : "hover:bg-muted"
                                    )}
                                    onClick={() => setSelectedCategory(null)}
                                >
                                    {t('common.all')}
                                </Button>
                                {categories.map(category => (
                                    <Button
                                        key={category}
                                        variant={selectedCategory === category ? "default" : "ghost"}
                                        className={cn(
                                            "justify-start capitalize whitespace-nowrap",
                                            selectedCategory === category ? "bg-primary text-primary-foreground shadow-lg shadow-primary/20" : "hover:bg-muted"
                                        )}
                                        onClick={() => setSelectedCategory(category)}
                                    >
                                        {category}
                                    </Button>
                                ))}
                            </div>
                        </div>
                    </div>
                </aside>

                {/* Main Product Grid */}
                <section className="lg:col-span-3">
                    {filteredProducts.length === 0 ? (
                        <div className="text-center py-20 bg-muted/30 rounded-2xl border border-dashed border-muted-foreground/20">
                            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-muted/50 mb-4">
                                <svg className="w-8 h-8 text-muted-foreground/50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                                </svg>
                            </div>
                            <p className="text-muted-foreground font-medium">{t('home.noProducts')}</p>
                            <p className="text-sm text-muted-foreground/60 mt-2">{t('home.checkBackLater')}</p>
                            {selectedCategory && (
                                <Button variant="link" onClick={() => setSelectedCategory(null)} className="mt-4">
                                    {t('common.all')}
                                </Button>
                            )}
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 xl:grid-cols-3">
                            {filteredProducts.map((product, index) => (
                                <Card
                                    key={product.id}
                                    className="group overflow-hidden flex flex-col tech-card animate-fade-in"
                                    style={{ animationDelay: `${index * 50}ms` }}
                                >
                                    {/* Image Section */}
                                    <div className="aspect-[4/3] bg-gradient-to-br from-muted/30 to-muted/10 relative overflow-hidden">
                                        <img
                                            src={product.image || `https://api.dicebear.com/7.x/shapes/svg?seed=${product.id}`}
                                            alt={product.name}
                                            className="object-cover w-full h-full transition-transform duration-500 group-hover:scale-105"
                                        />
                                        {/* Overlay gradient */}
                                        <div className="absolute inset-0 bg-gradient-to-t from-background/80 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
                                        {product.category && product.category !== 'general' && (
                                            <Badge className="absolute top-3 right-3 capitalize bg-background/80 backdrop-blur-sm border-border/50 text-foreground shadow-sm">
                                                {product.category}
                                            </Badge>
                                        )}
                                    </div>

                                    {/* Content Section */}
                                    <CardContent className="flex-1 p-5">
                                        <div className="flex items-start justify-between gap-2 mb-2">
                                            <h3 className="font-semibold text-lg group-hover:text-primary transition-colors duration-300 leading-tight">
                                                {product.name}
                                            </h3>
                                        </div>

                                        {/* Rating */}
                                        {product.reviewCount !== undefined && product.reviewCount > 0 && (
                                            <div className="flex items-center gap-2 mb-3">
                                                <StarRating rating={Math.round(product.rating || 0)} size="sm" />
                                                <span className="text-xs text-muted-foreground font-medium">({product.reviewCount})</span>
                                            </div>
                                        )}

                                        <div className="text-muted-foreground text-sm line-clamp-2 leading-relaxed prose prose-sm dark:prose-invert max-w-none [&_p]:m-0 [&_p]:inline [&_h1]:inline [&_h2]:inline [&_h3]:inline [&_h4]:inline [&_h5]:inline [&_h6]:inline [&_ul]:inline [&_ol]:inline [&_li]:inline">
                                            <ReactMarkdown
                                                allowedElements={["p", "strong", "em", "del", "text", "span"]}
                                                unwrapDisallowed={true}
                                            >
                                                {product.description || t('buy.noDescription')}
                                            </ReactMarkdown>
                                        </div>
                                    </CardContent>

                                    {/* Footer Section */}
                                    <CardFooter className="p-5 pt-0 flex items-end justify-between gap-3">
                                        <div className="shrink-0 flex flex-col">
                                            <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider">{t('common.credits')}</span>
                                            <span className="text-2xl font-bold font-mono tracking-tight">{Number(product.price)}</span>
                                        </div>
                                        <div className="flex flex-col items-end gap-2 min-w-0">
                                            <div className="flex flex-wrap justify-end gap-1.5 opacity-80 hover:opacity-100 transition-opacity">
                                                <Badge variant="outline" className="text-[10px] h-5 px-1.5 text-muted-foreground border-border/50 whitespace-nowrap">
                                                    {t('common.sold')} {product.soldCount}
                                                </Badge>
                                                <Badge
                                                    variant={product.stockCount > 0 ? "secondary" : "destructive"}
                                                    className="text-[10px] h-5 px-1.5 whitespace-nowrap"
                                                >
                                                    {product.stockCount > 0 ? `${t('common.stock')} ${product.stockCount}` : t('common.outOfStock')}
                                                </Badge>
                                            </div>
                                            <Link href={`/buy/${product.id}`} className="w-full">
                                                <Button
                                                    size="sm"
                                                    className="w-full bg-foreground text-background hover:bg-foreground/90 whitespace-nowrap shadow-md hover:shadow-lg transition-all"
                                                >
                                                    {t('common.viewDetails')}
                                                </Button>
                                            </Link>
                                        </div>
                                    </CardFooter>
                                </Card>
                            ))}
                        </div>
                    )}
                </section>
            </div>
        </main>
    )
}
