

let testVec = [
[
    new Imaginary(),
    new GeoVec('x'),
    new Imaginary(),
    new GeoVec('y'),
    new ScalarExpression(2)
],
[
    new GeoVec('x')
],
[
    new GeoVec('y')
],
[
    new Imaginary(),
    new GeoVec('x'),
    new Imaginary(),
    new GeoVec('y')
],
[
    new Imaginary(),
    new GeoVec('x'),
    new GeoVec('y'),
    new GeoVec('x')
],
[
    new GeoVec('x'),
    new ScalarExpression(4)
],
];

let combinedTerms = combineLikeTerms(testVec);

let a = [[new GeoVec('x')], [new GeoVec('y')]];  // x + y
let b = [[new GeoVec('x')], [new ScalarExpression(-1), new GeoVec('y')]];  // x - y
let result = multiplyVecs(a, b);  // (x+y)(x-y)

let testExp = {
    a:3,
    b:5,
    evaluate(){
        return this.a*this.b;
    }
}