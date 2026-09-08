import { useEffect } from 'react'
import type { EditorState } from '../office/editor/editorState.js'
import { EditTool } from '../office/types.js'

export function useEditorKeyboard(
  /**
   * Element the shortcuts are bound to. The desktop app listened on `window`,
   * which inside Obsidian would rotate furniture while you type an "r" into a
   * note. Bound to the office pane instead, the keys only fire while that pane
   * has focus.
   */
  root: HTMLElement | null,
  isEditMode: boolean,
  editorState: EditorState,
  onDeleteSelected: () => void,
  onRotateSelected: () => void,
  onToggleState: () => void,
  onUndo: () => void,
  onRedo: () => void,
  onEditorTick: () => void,
  onCloseEditMode: () => void,
): void {
  useEffect(() => {
    if (!isEditMode) return
    const target: HTMLElement | Window = root ?? window
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Multi-stage Esc: deselect item → close tool → deselect placed → close editor
        if (editorState.activeTool === EditTool.FURNITURE_PICK) {
          editorState.activeTool = EditTool.FURNITURE_PLACE
          editorState.clearGhost()
        } else if (editorState.activeTool === EditTool.FURNITURE_PLACE && editorState.selectedFurnitureType !== '') {
          editorState.selectedFurnitureType = ''
          editorState.clearGhost()
        } else if (editorState.activeTool !== EditTool.SELECT) {
          editorState.activeTool = EditTool.SELECT
          editorState.clearGhost()
        } else if (editorState.selectedFurnitureUid) {
          editorState.clearSelection()
        } else {
          onCloseEditMode()
          return
        }
        editorState.clearDrag()
        onEditorTick()
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (editorState.selectedFurnitureUid) {
          onDeleteSelected()
        }
      } else if (e.key === 'r' || e.key === 'R') {
        onRotateSelected()
      } else if (e.key === 't' || e.key === 'T') {
        onToggleState()
      } else if (e.key === 'z' && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
        e.preventDefault()
        e.stopPropagation()
        onUndo()
      } else if (
        (e.key === 'y' && (e.ctrlKey || e.metaKey)) ||
        (e.key === 'z' && (e.ctrlKey || e.metaKey) && e.shiftKey)
      ) {
        e.preventDefault()
        e.stopPropagation()
        onRedo()
      }
    }
    target.addEventListener('keydown', handler as EventListener)
    return () => target.removeEventListener('keydown', handler as EventListener)
  }, [root, isEditMode, editorState, onDeleteSelected, onRotateSelected, onToggleState, onUndo, onRedo, onEditorTick, onCloseEditMode])
}
