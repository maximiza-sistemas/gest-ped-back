/* ============================================================
   Escopo de acesso por perfil.

   - admin / secretaria: alcance de rede (sem restrição por escola).
   - gestor: restrito ao seu grupo de escolas (Usuario.escolaIds,
     transportado no JWT).
   - professor: escopo é por profId (tratado nas próprias rotas).
   ============================================================ */

/**
 * Lista de escolas a que um gestor está restrito.
 * @returns {string[] | null} array de escolaIds para gestor;
 *   null quando o perfil tem alcance de rede ou não usa filtro por escola.
 */
export function gestorEscolas(user) {
  if (user?.perfil === 'gestor') {
    return Array.isArray(user.escolaIds) ? user.escolaIds : [];
  }
  return null;
}
