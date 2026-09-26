import { auth } from '@clerk/tanstack-react-start/server'
import { createFileRoute, redirect } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'

const requireSession = createServerFn({ method: 'GET' }).handler(async () => {
  const session = await auth()
  if (!session.isAuthenticated) throw redirect({ to: '/sign-in/$' })
})

export const Route = createFileRoute('/_authenticated')({
  beforeLoad: () => requireSession(),
})
