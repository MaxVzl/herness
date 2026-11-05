import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
// @ts-expect-error le CSS est empaqueté par esbuild, sans déclaration de module
import './styles.css'

const mount = document.getElementById('app')
if (!mount) throw new Error('élément #app introuvable')
createRoot(mount).render(<App />)
