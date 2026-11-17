" Herdr reports a mouse wheel notch to a program that takes the mouse as three
" reports, one per line scrolled (vim's mouse=a). Vim scrolls three lines a
" report, so a notch jumped nine; one line a report makes it three, as in other
" terminals. Only inside Herdr: VTE terminals (Tilix, GNOME Terminal) send one
" report a notch. Installed into ~/.vim/plugin by personal/setup.sh; edit
" personal/vim/herdr-wheel.vim instead.
if exists('g:loaded_herdr_wheel') || (empty($HC_TERMINAL_ID) && $TERM_PROGRAM !=# 'herdr')
  finish
endif
let g:loaded_herdr_wheel = 1
let s:cpo = &cpo
set cpo&vim
if exists('+mousescroll')
  " Newer Vim and Neovim set the scroll amount itself.
  set mousescroll=ver:1
else
  noremap <ScrollWheelUp> <C-Y>
  noremap <ScrollWheelDown> <C-E>
  inoremap <ScrollWheelUp> <C-X><C-Y>
  inoremap <ScrollWheelDown> <C-X><C-E>
endif
let &cpo = s:cpo
unlet s:cpo
