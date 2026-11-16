// expect: letterbox/no-ui-in-shell x5, letterbox/no-cross-package-relative-import x1

import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { ReactNode } from 'react'
import { client } from '../../../apps/desktop/renderer/src/core.ts'

export type Node = ReactNode
export const parts = [useState, createRoot, client]
export const later = () => import('@letterbox/desktop-renderer')
