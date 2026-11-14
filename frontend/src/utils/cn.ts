import { type ClassValue, clsx } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [
        {
          text: [
            'button',
            'body',
            'body-sm',
            'heading-1',
            'heading-2',
            'heading-3',
            'label',
            'caption',
          ],
        },
      ],
      // tailwind.config.js ringWidth; without it `ring-status` reads as a ring colour and is dropped.
      'ring-w': [{ ring: ['status'] }],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
