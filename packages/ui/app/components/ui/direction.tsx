import * as React from 'react'

export type Direction = 'ltr' | 'rtl'

const DirectionContext = React.createContext<Direction>('ltr')

export function DirectionProvider({
  children,
  direction = 'ltr',
}: {
  children: React.ReactNode
  direction?: Direction
}) {
  return (
    <DirectionContext.Provider value={direction}>
      {children}
    </DirectionContext.Provider>
  )
}

export function useDirection() {
  return React.useContext(DirectionContext)
}
