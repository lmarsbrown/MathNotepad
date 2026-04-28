let idRegistry = {};

/**
 * @typedef {AlgebraicObject[]} Term - An ordered product of algebraic units representing one multiplicative term
 * @typedef {Term[]} AlgebraVec - A sum of Terms representing a full multivector expression
 */

// This base class is incomplete and should never be instantiated directly
class AlgebraicObject{
    // Must have Id,
    // Must have commutes with
    // Must have combines with
    constructor(){
        this.exponent = 1;
        this.label = this.constructor.name;
        this.id = idRegistry[this.constructor.name];

        if(this.id === undefined){
            console.error("Algebraic object of type "+this.constructor.name+" has not been added to the registry!");
        }

        if(this.constructor == AlgebraicObject){
            console.error("Attempting to instantiate a raw AlgebraicObject! This is not allowed!");
        }
    }

    /**
     * Describes how two units interact under multiplication — commutes them into canonical order
     * and applies any product rules (e.g. i*i = -1). Returns the updated pair/product, or null
     * if the units are already in order and have no special interaction.
     * @param {AlgebraicObject} other - The unit being multiplied with this one (the left operand after any flip)
     * @param {boolean} orderFlipped - True when `other` originally appeared before `this` and was swapped to enforce canonical id ordering
     * @returns {AlgebraicObject[]|null} Replacement units spliced into the term, or null if no change is needed
     */
    combineWith(other,orderFlipped){
        if(this.id==other.id){
            let output = this.clone();
            output.exponent = this.exponent + other.exponent;
            return [output];
        }
        if(orderFlipped){
            return [other,this];
        }
        return null;
    }

    /**
     * Attempts to add this unit to another, returning the combined unit or false if they cannot be added.
     * Subclasses should override this if they have special behaviour under addition.
     * @param {AlgebraicObject} other - The unit to add to this one
     * @returns {AlgebraicObject|false} The summed unit, or false if the units are not like terms
     */
    attemptAdd(other){
        if(other.id == this.id && other.exponent == this.exponent){
            return this;
        }
        else{
            return false;
        }

    }

    /**
     * Compares this unit against another for sorting purposes, used to group like terms.
     * @param {AlgebraicObject} other - The unit to compare against
     * @returns {number} Negative if this should sort before other, positive if after, 0 if equal
     */
    compareWith(other){
        let idDiff = this.id-other.id;
        if(idDiff != 0){
            return idDiff;
        }
        return other.exponent - this.exponent;
    }
}

/**
 * Simplifies an ordered list of units by commuting them into canonical id order and applying
 * product rules (e.g. collapsing i*i into -1). Ensures the first element is always a ScalarExpression.
 * @param {AlgebraicObject[]} terms - Unsimplified ordered product of units
 * @returns {AlgebraicObject[]} Simplified term with units in canonical order
 */
function simplifyUnits(terms){
    if(terms.length === 0){
        return [];
    }
    let newUnits = [];
    for(let i = 0; i < terms.length; i++){
        let headIndex = 0;
        newUnits.unshift(terms[terms.length-i-1]);

        let emergencyExit = 0;
        let exitLimit = 10*terms.length**2;

        while(headIndex<newUnits.length-1&&emergencyExit<exitLimit){
            if(newUnits.length>=2){
                //Get the two units at the product
                let u1 = newUnits[headIndex];
                let u2 = newUnits[headIndex+1];

                //Make sure the unit with the higher ID comes second.
                let orderFlipped = u1.id>u2.id;
                if(orderFlipped){
                    [u1,u2]=[u2,u1];
                }

                // Compute the commutation or product of the terms.
                let product = u2.combineWith(u1,orderFlipped);

                //If the do not commute(or multiply), then move onto the next unit.
                if(product === null){
                    headIndex++;
                    continue;
                }else{
                    //If the two do something together splice the updated form back into the terms list
                    newUnits.splice(headIndex,2,...product);

                    if(headIndex!=0){
                        //Moving the head index back is necesary in case something earlier in the list interacts with the second element. Example:
                        // Let i be the imaginary number, and x be the x unit vector, and p be a point. We will define their order such that p comes before x comes before i.
                        // Suppose that the current state of the list is [p,x,i].
                        // We add another i making the list [i,p,x,i]
                        // We swap twice [p,x,i,i] and simplify i^2, [p,x,-1]
                        // Now we need to swap -1 with x so we need to go back once ](this is for combining)
                        //[p,-1,x] The problem is that we now need to swap again further back, so after that swap we should move back again
                        //[-1,p,x] is our final state and is correct
                        headIndex--;

                        //Decrementing here should never cause an infinite loop because the units will only return an array value (not -1) if they are in the wrong order and commute. After that, that pair of units should always return null if called together.
                    }
                }
            }
            emergencyExit++;
        }
        if(emergencyExit == exitLimit){
            console.error("Error: Simplify units entered infinite loop");
            debugger;
        }
    }
    if(newUnits.length==0||newUnits[0].id != 0){
        newUnits.unshift(new ScalarExpression(1))
    }
    return newUnits;
}

/**
 * Comparator for sorting Terms, used to group like terms before combining them.
 * Sorts by term length first (shorter terms first), then by unit id for aesthetic ordering.
 * @param {Term} a - First term to compare
 * @param {Term} b - Second term to compare
 * @returns {number} Negative if a sorts before b, positive if after, 0 if equivalent
 */
function compareTerms(a,b){
    let aOff = 0;
    let bOff = 0;
    if(a[0].id == 0){
        aOff = 1;
    }
    if(b[0].id == 0){
        bOff = 1;
    }

    //We want longer terms to end up at the end of the array (looks nicer)
    let lengthDiff = (a.length-aOff)-(b.length-bOff);
    if(lengthDiff != 0){
        return lengthDiff;
    }

    //We want terms that have a lower id to appear earlier in the array
    //This makes more fundemental terms appear earlier which also looks nicer
    for(let i = 0; i < Math.min(a.length-aOff,b.length-bOff); i++){
        let comparison = a[i+aOff].compareWith(b[i+bOff]);

        if(comparison!=0){
            return comparison;
        }
    }
    return 0;
}

/**
 * Attempts to add two Terms unit-by-unit. Both terms must have the same length and each
 * corresponding pair of units must be addable; otherwise returns false.
 * @param {Term} a - First term
 * @param {Term} b - Second term
 * @returns {Term|false} The combined term, or false if the terms are not like terms
 */
function attemptAddTerms(a,b){
    if(a.length!=b.length){
        return false;
    }
    let output = [];
    for(let i = 0; i < a.length; i++){
        let newUnit = a[i].attemptAdd(b[i]);
        if(newUnit === false){
            return false;
        }
        else{
            output.push(newUnit);
        }
    }

    return output;
}

/**
 * Simplifies each Term in an AlgebraVec and combines any like terms by adding their coefficients.
 * @param {AlgebraVec} vec - Array of unsimplified terms
 * @returns {AlgebraVec} Fully simplified array of terms with like terms merged
 */
function combineLikeTerms(vec){
    if(vec.length == 0){
        console.warn("Attempting to combine like terms on an empty vector")
        return [];
    }

    let sortedTerms = [];
    for(let i = 0; i < vec.length; i++){
        sortedTerms.push(simplifyUnits(vec[i]));
    }
    sortedTerms.sort(compareTerms);

    let output = [sortedTerms[0]];
    for(let i = 1; i < sortedTerms.length; i++){
        let summedTerm = attemptAddTerms(output[output.length-1],sortedTerms[i]);
        if(summedTerm === false){
            output.push(sortedTerms[i]);
        }
        else{
            output[output.length-1] = summedTerm;
        }
    }
    return output;
}

/**
 * Adds two AlgebraVecs by concatenating their terms and combining like terms.
 * @param {AlgebraVec} vec1 - First operand
 * @param {AlgebraVec} vec2 - Second operand
 * @returns {AlgebraVec} The simplified sum
 */
function addVecs(vec1,vec2){
    return combineLikeTerms([...vec1,...vec2])
}

/**
 * Multiplies two AlgebraVecs using the distributive property, then simplifies the result.
 * @param {AlgebraVec} vec1 - First operand
 * @param {AlgebraVec} vec2 - Second operand
 * @returns {AlgebraVec} The simplified product
 */
function multiplyVecs(vec1, vec2){
    let product = [];
    for(let i = 0; i < vec1.length; i++){
        for(let j = 0; j < vec2.length; j++){
            product.push([...vec1[i], ...vec2[j]]);
        }
    }
    return combineLikeTerms(product);
}
