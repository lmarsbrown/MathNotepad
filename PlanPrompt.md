I want to create a notepad program for working on math assignments that uses the javascript library MathQuill to have equation editing functionality similar to desmos. 

The program should have two main windows. The window on the left should have the text/raw latex form of everything, while the window on the right has the graphic form. The window on the right should have a box for each equation (similar to desmos). Each of these boxes should correspond to a new line in the text form. Pressing enter while in a box should create a new empty box below and switch you to editing that box. Pressing backspace in an empty box should delete that box. You should also be able to delete the box by pressing an x in the corner. There should be a button above the right window that will add a box/line that is meant for text rather than equations. It should be possible to infer the state of the boxes from the text side alone, and the text side should be valid latex. 
The main point of this project is to allow me to easily write out and manipulate equations digitally (for doing algebra etc) without having to rewrite them after the fact to have them be typeset. 

While I don't want to do this right now, in the future I may want to add functionality for evaluating and graphing expressions so keep that in mind.

One thing I am not sure about is the most efficient way to give you access to the mathquill library. 

---

Construct a plan for this project and then we will start implementing it. 