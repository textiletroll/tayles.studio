import './styles/main.css';
import { PegBoard } from './grid/PegBoard.js';
import { EditMode } from './edit/EditMode.js';
import layout from './data/layout.json';

const container = document.getElementById('pegboard');
const board = new PegBoard(container);
board.loadLayout(layout);

const editor = new EditMode(board);
