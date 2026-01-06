'use client'

import { Star } from 'lucide-react'
import { cn } from '@/lib/utils'

interface StarRatingProps {
    rating: number
    maxRating?: number
    size?: 'sm' | 'md' | 'lg'
    interactive?: boolean
    onChange?: (rating: number) => void
}

export function StarRating({
    rating,
    maxRating = 5,
    size = 'md',
    interactive = false,
    onChange
}: StarRatingProps) {
    const sizeClasses = {
        sm: 'w-3 h-3',
        md: 'w-4 h-4',
        lg: 'w-5 h-5'
    }

    const handleClick = (index: number) => {
        if (interactive && onChange) {
            onChange(index + 1)
        }
    }

    return (
        <div className="flex items-center gap-0.5">
            {Array.from({ length: maxRating }, (_, i) => (
                <button
                    key={i}
                    type="button"
                    disabled={!interactive}
                    onClick={() => handleClick(i)}
                    className={cn(
                        "transition-colors",
                        interactive && "cursor-pointer hover:scale-110"
                    )}
                >
                    <Star
                        className={cn(
                            sizeClasses[size],
                            i < rating
                                ? "fill-yellow-400 text-yellow-400"
                                : "fill-muted text-muted-foreground/30"
                        )}
                    />
                </button>
            ))}
        </div>
    )
}
