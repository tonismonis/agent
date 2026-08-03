import { SignIn } from '@clerk/tanstack-react-start'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/sign-in')({
  component: SignInPage,
})

function SignInPage() {
  return (
    <main className="grid min-h-screen place-items-center bg-zinc-50">
      <SignIn forceRedirectUrl="/" />
    </main>
  )
}
