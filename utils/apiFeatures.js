class APIFeatures {
  constructor(getAll, queryString) {
    this.getAll = getAll;
    this.queryString = queryString;
  }

  filter() {
    const queryObj = { ...this.queryString };
    const excludedFields = ["page", "sort", "limit", "fields"];
    excludedFields.forEach((el) => delete queryObj[el]);

    // ADVANCE FILTERING
    let queryStr = JSON.stringify(queryObj);
    queryStr = queryStr.replace(/\b(gte|gt|lte|lt)\b/g, (match) => `$${match}`);
    
    if (Object.keys(JSON.parse(queryStr)).length > 0) {
      this.getAll = this.getAll.find(JSON.parse(queryStr));
    }
    return this;
  }

  sort() {
    if (this.queryString.sort) {
      const sortBy = this.queryString.sort.split(",").join(" ");
      this.getAll = this.getAll.sort(sortBy);
    } else {
      this.getAll = this.getAll.sort("-createdAt");
    }
    return this;
  }

  // Alias for backward compatibility
  sorting() {
    return this.sort();
  }

  limitFields() {
    if (this.queryString.fields) {
      const getfields = this.queryString.fields.split(",").join(" ");
      this.getAll = this.getAll.select(getfields);
    } else {
      this.getAll = this.getAll.select("-__v");
    }
    return this;
  }

  // Alias for backward compatibility
  fields() {
    return this.limitFields();
  }

  paginate() {
    const page = this.queryString.page * 1 || 1;
    const limit = this.queryString.limit * 1 || 10;
    const skip = (page - 1) * limit;
    this.getAll = this.getAll.skip(skip).limit(limit);
    return this;
  }

  // Alias for backward compatibility
  paginations() {
    return this.paginate();
  }

  // Getter for query (used in controllers)
  get query() {
    return this.getAll;
  }

  // Get the filter object for counting (without pagination)
  getFilterObject() {
    const queryObj = { ...this.queryString };
    const excludedFields = ["page", "sort", "limit", "fields"];
    excludedFields.forEach((el) => delete queryObj[el]);

    // ADVANCE FILTERING
    let queryStr = JSON.stringify(queryObj);
    queryStr = queryStr.replace(/\b(gte|gt|lte|lt)\b/g, (match) => `$${match}`);
    
    if (Object.keys(JSON.parse(queryStr)).length > 0) {
      return JSON.parse(queryStr);
    }
    return {};
  }
}
export default APIFeatures;
