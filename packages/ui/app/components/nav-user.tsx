import {
  ChevronsUpDown,
  Boxes,
  Paintbrush,
  Settings2,
} from "lucide-react"
import { useNavigate } from "react-router"

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "#/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "#/components/ui/sidebar"

export function NavUser({
  onOpenChange,
  user,
}: {
  onOpenChange?: (open: boolean) => void
  user: {
    name: string
    email: string
    avatar: string
  }
}) {
  const navigate = useNavigate()

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu onOpenChange={onOpenChange}>
          <SidebarMenuButton
            render={<DropdownMenuTrigger />}
            size="lg"
            className="data-popup-open:bg-sidebar-accent data-popup-open:text-sidebar-accent-foreground"
          >
            <Avatar className="h-8 w-8 rounded-lg">
              <AvatarImage src={user.avatar} alt={user.name} />
              <AvatarFallback className="rounded-lg">ZV</AvatarFallback>
            </Avatar>
            <div className="grid flex-1 text-left text-sm leading-tight">
              <span className="truncate font-medium">{user.name}</span>
              <span className="truncate text-xs">{user.email}</span>
            </div>
            <ChevronsUpDown className="ms-auto size-4" />
          </SidebarMenuButton>
          <DropdownMenuContent
            className="w-(--anchor-width) min-w-0 rounded-lg"
            side="bottom"
            align="start"
            sideOffset={4}
          >
            <DropdownMenuGroup>
              <DropdownMenuLabel className="p-0 font-normal">
                <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                  <Avatar className="h-8 w-8 rounded-lg">
                    <AvatarImage src={user.avatar} alt={user.name} />
                    <AvatarFallback className="rounded-lg">ZV</AvatarFallback>
                  </Avatar>
                  <div className="grid flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-medium">{user.name}</span>
                    <span className="truncate text-xs">{user.email}</span>
                  </div>
                </div>
              </DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem
                onClick={() => navigate("/settings", { viewTransition: true })}
              >
                <Settings2 />
                Global settings
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() =>
                  navigate("/settings/appearance", { viewTransition: true })
                }
              >
                <Paintbrush />
                Appearance
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => navigate("/services", { viewTransition: true })}
              >
                <Boxes />
                Runtime services
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
