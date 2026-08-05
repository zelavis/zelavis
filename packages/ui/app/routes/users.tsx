import { useLoaderData } from "react-router"
import { CheckCircle2, Circle, Search, UserRound } from "lucide-react"
import { useMemo, useState } from "react"

import { ResourceNotice } from "#/components/DashboardPage"
import { Avatar, AvatarFallback } from "#/components/ui/avatar"
import { Badge } from "#/components/ui/badge"
import { Button } from "#/components/ui/button"
import { Input } from "#/components/ui/input"
import {
  getRuntimeConfig,
  listAuthAccounts,
  type AuthAccount,
} from "#/lib/runtime-api"

export const handle = {
  pageLabel: "Users",
} as const

type UserFilter = "All" | "Verified" | "Unverified"

const userFilters: UserFilter[] = ["All", "Verified", "Unverified"]

export async function clientLoader() {
  const runtime = await getRuntimeConfig()
  const accounts = await listAuthAccounts(runtime)
  return { accounts }
}

function UsersRoute() {
  const { accounts } = useLoaderData<typeof clientLoader>()
  const [query, setQuery] = useState("")
  const [activeFilter, setActiveFilter] = useState<UserFilter>("All")

  const filteredAccounts = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()

    return accounts.filter((account) => {
      if (activeFilter === "Verified" && !account.verified) {
        return false
      }
      if (activeFilter === "Unverified" && account.verified) {
        return false
      }
      if (!normalizedQuery) {
        return true
      }

      return [
        account.displayName,
        account.email,
        account.username,
        account.id,
      ].some((value) => value?.toLowerCase().includes(normalizedQuery))
    })
  }, [accounts, activeFilter, query])

  return (
    <section className="w-full">
      <div className="overflow-hidden rounded-lg border bg-background">
        <div className="border-b p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <h1 className="text-base font-semibold">Users</h1>
              <p className="text-sm text-muted-foreground">
                {`${filteredAccounts.length} account${filteredAccounts.length === 1 ? "" : "s"}`}
              </p>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {userFilters.map((filter) => (
                <Button
                  key={filter}
                  type="button"
                  variant={activeFilter === filter ? "secondary" : "ghost"}
                  onClick={() => setActiveFilter(filter)}
                >
                  {filter}
                </Button>
              ))}
            </div>
          </div>
          <label className="relative mt-4 block">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search users"
              className="pl-9"
            />
          </label>
        </div>

        <ul className="divide-y">
          {filteredAccounts.length === 0 ? (
            <li className="p-4 text-sm text-muted-foreground">
              No users found
            </li>
          ) : null}
          {filteredAccounts.map((account) => (
            <UserListItem key={account.id} account={account} />
          ))}
        </ul>
      </div>
    </section>
  )
}

function UserListItem({ account }: { account: AuthAccount }) {
  const name = getAccountName(account)
  const secondary = getAccountSecondary(account)

  return (
    <li className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/40">
      <Avatar size="lg">
        <AvatarFallback>{getAccountInitials(account)}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <p className="truncate text-sm font-medium">{name}</p>
          <Badge
            variant={account.verified ? "secondary" : "outline"}
            className="gap-1"
          >
            {account.verified ? (
              <CheckCircle2 data-icon="inline-start" />
            ) : (
              <Circle data-icon="inline-start" />
            )}
            {account.verified ? "Verified" : "Unverified"}
          </Badge>
        </div>
        <p className="truncate text-sm text-muted-foreground">{secondary}</p>
      </div>
      <div className="hidden shrink-0 text-right sm:block">
        <p className="text-sm text-muted-foreground">
          {formatDate(account.createdAt)}
        </p>
      </div>
    </li>
  )
}

function getAccountName(account: AuthAccount) {
  return account.displayName ?? account.username ?? account.email ?? account.id
}

function getAccountSecondary(account: AuthAccount) {
  if (account.email && account.email !== getAccountName(account)) {
    return account.email
  }
  if (account.username && account.username !== getAccountName(account)) {
    return `@${account.username}`
  }

  return account.id
}

function getAccountInitials(account: AuthAccount) {
  const name = getAccountName(account)
  const parts = name
    .replace(/@.*/, "")
    .split(/[\s._-]+/)
    .filter(Boolean)

  if (parts.length === 0) {
    return <UserRound className="size-4" />
  }

  return parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("")
}

function formatDate(value: string) {
  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return value
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date)
}

export default UsersRoute
