/**
 * @typedef {Object} ScalarNode - A single node in a scalar expression term
 * @property {number} type - Node type: 0 = NUMBER, 1 = VARIABLE (use ScalarExpression.NODE_TYPES)
 * @property {number|string} value - Numeric value for NUMBER nodes; variable name string for VARIABLE nodes
 * @property {number} [exponent] - Exponent for VARIABLE nodes (defaults to 1 if absent)
 * @property {function(): number|string} evaluate - Returns this node's value
 */

// Scalar expressions use sum-of-products form: a 2D array where the outer array is a sum of terms
// and each inner array (term) is an ordered product of ScalarNodes.
class ScalarExpression extends AlgebraicObject{
    static NODE_TYPES = {
        NUMBER:0,
        VARIABLE:1,
    }
    constructor(value){
        super();
        this.expression = [[{
            type:ScalarExpression.NODE_TYPES.NUMBER,
            value:value,
            evaluate(){
                return this.value;
            }
        }]];
    }

    /**
     * Multiplies this ScalarExpression with another unit. If the other unit is also a
     * ScalarExpression, they are combined via scalar multiplication; otherwise defers to
     * the default commutation/ordering behaviour.
     * @param {AlgebraicObject} other - The unit to combine with
     * @param {boolean} orderFlipped - Whether the canonical order was reversed before this call
     * @returns {AlgebraicObject[]|null} Replacement units, or null if no interaction applies
     */
    combineWith(other,orderFlipped){
        if(other.id == this.id){
            return [ScalarExpression.multiply(this, other)];
        }

        if(orderFlipped){
            return [other,this];
        }
        return null;
    }

    /**
     * Attempts to add another unit to this ScalarExpression.
     * Succeeds only when the other unit is also a ScalarExpression.
     * @param {AlgebraicObject} other - The unit to add
     * @returns {ScalarExpression|false} The summed ScalarExpression, or false if addition is not possible
     */
    attemptAdd(other){
        if(other.id == this.id){
            return ScalarExpression.add(this, other);
        }
        else{
            return false;
        }

    }

    /**
     * Creates a deep copy of this ScalarExpression, cloning every node to prevent mutation of the original.
     * @returns {ScalarExpression} An independent copy of this expression
     */
    clone(){
        let cloned = new ScalarExpression(0);
        cloned.expression = this.expression.map(term =>
            term.map(node => ({
                type: node.type,
                value: node.value,
                exponent: node.exponent,
                evaluate() { return this.value; }
            }))
        );
        return cloned;
    }

    /**
     * Adds two ScalarExpressions by concatenating their terms, simplifying each term,
     * then merging like terms. Example: (2x + 3y) + (4x + 5) = 6x + 3y + 5.
     * @param {ScalarExpression} expr1 - Left operand
     * @param {ScalarExpression} expr2 - Right operand
     * @returns {ScalarExpression} The simplified sum
     */
    static add(expr1, expr2) {
        let result = [...expr1.expression, ...expr2.expression];
        result = result.map(term => ScalarExpression._simplifyTerm(term));
        result = ScalarExpression._combineLikeTerms(result);

        let output = new ScalarExpression(0);
        output.expression = result;
        return output;
    }

    /**
     * Multiplies two ScalarExpressions using the distributive property, then simplifies.
     * Example: (x + 2)(x - 3) = x^2 - x - 6.
     * @param {ScalarExpression} expr1 - Left operand
     * @param {ScalarExpression} expr2 - Right operand
     * @returns {ScalarExpression} The simplified product
     */
    static multiply(expr1, expr2) {
        let result = [];

        for (let term1 of expr1.expression) {
            for (let term2 of expr2.expression) {
                let newTerm = [...term1, ...term2];
                result.push(newTerm);
            }
        }

        result = result.map(term => ScalarExpression._simplifyTerm(term));
        result = ScalarExpression._combineLikeTerms(result);

        let output = new ScalarExpression(0);
        output.expression = result;
        return output;
    }

    /**
     * Simplifies a single product term by multiplying all numeric coefficients together
     * and combining same-named variables by summing their exponents.
     * Returns a normalized term: numeric coefficient first, then variables in sorted order.
     * Example: [2, x, 3, x, y] → [6, x^2, y].
     * @param {ScalarNode[]} term - An unsimplified product of scalar nodes
     * @returns {ScalarNode[]} The simplified term
     */
    static _simplifyTerm(term) {
        let numericProduct = 1;
        let variables = {};

        for (let node of term) {
            if (node.type === ScalarExpression.NODE_TYPES.NUMBER) {
                numericProduct *= node.value;
            } else if (node.type === ScalarExpression.NODE_TYPES.VARIABLE) {
                let varName = node.value;
                let exponent = node.exponent || 1;
                if (variables[varName]) {
                    variables[varName].exponent += exponent;
                } else {
                    variables[varName] = { exponent: exponent };
                }
            }
        }

        let simplified = [];

        simplified.push({
            type: ScalarExpression.NODE_TYPES.NUMBER,
            value: numericProduct,
            evaluate() { return this.value; }
        });

        let sortedVars = Object.keys(variables).sort();
        for (let varName of sortedVars) {
            let exp = variables[varName].exponent;
            if (exp !== 0) {
                simplified.push({
                    type: ScalarExpression.NODE_TYPES.VARIABLE,
                    value: varName,
                    exponent: exp,
                    evaluate() { return this.value; }
                });
            }
        }

        return simplified;
    }

    /**
     * Produces a unique string key for a term based solely on its variables and their exponents,
     * ignoring the numeric coefficient. Used to identify like terms.
     * Example: [3, x^2, y] and [5, x^2, y] both produce "x^2*y".
     * @param {ScalarNode[]} term - A simplified product term
     * @returns {string} The variable signature string
     */
    static _getTermSignature(term) {
        let vars = [];
        for (let node of term) {
            if (node.type === ScalarExpression.NODE_TYPES.VARIABLE) {
                vars.push(node.value + "^" + (node.exponent || 1));
            }
        }
        return vars.sort().join("*");
    }

    /**
     * Combines like terms by summing the coefficients of terms that share the same variable signature.
     * Drops any terms whose coefficient is zero. Returns a zero term if all terms cancel.
     * @param {ScalarNode[][]} terms - Array of simplified product terms
     * @returns {ScalarNode[][]} Array of terms with like terms merged and zero terms removed
     */
    static _combineLikeTerms(terms) {
        let termMap = {};

        for (let term of terms) {
            let sig = ScalarExpression._getTermSignature(term);
            if (termMap[sig]) {
                let existingCoef = termMap[sig][0].value;
                let newCoef = term[0].value;
                termMap[sig][0].value = existingCoef + newCoef;
            } else {
                termMap[sig] = term;
            }
        }

        let result = [];
        for (let sig in termMap) {
            if (termMap[sig][0].value !== 0) {
                result.push(termMap[sig]);
            }
        }

        if (result.length === 0) {
            result.push([{
                type: ScalarExpression.NODE_TYPES.NUMBER,
                value: 0,
                evaluate() { return this.value; }
            }]);
        }

        return result;
    }
}


class VariableExpression{
    constructor(definition){
        this.definition = definition;
        this.terms = this.definition.evaluate();

        this.termResults = [];
        this.dependents = [];
    }
    getReferenceVector(){
        let output = [];
        for(let i = 0; i < this.terms.length; i++){
            output.push({
                type:ScalarExpression.NODE_TYPES.VARIABLE,
                evaluate=()=>{
                    return this.termResults[i];
                }
            });
        }
        return output;
    }
    updateSymbolic(){
        this.terms = this.definition.evaluate();
        for(let i = 0; i < this.dependents.length; i++){
            this.dependents[i].updateSymbolic();
        }
        this.updateNumerical();
    }
    updateNumerical(){
        for(let i = 0; i < this.terms.length; i++){
            this.termResults[i] = this.terms[i].evaluate();
        }
        for(let i = 0; i < this.dependents.length; i++){
            this.dependents[i].updateNumerical();
        }
    }

}