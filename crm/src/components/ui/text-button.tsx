import type { ComponentProps } from 'react'

const tones = {
  mute: 'text-ink-mute',
  faint: 'text-ink-faint',
  ink: 'text-ink',
}

export function TextButton({
  tone,
  type = 'button',
  className = '',
  ...props
}: ComponentProps<'button'> & { tone: keyof typeof tones }) {
  return (
    <button
      {...props}
      className={`font-meta text-meta uppercase cursor-pointer hover:text-ink disabled:cursor-not-allowed disabled:text-ink-faint disabled:hover:text-ink-faint ${tones[tone]} ${className}`}
      type={type}
    />
  )
}
